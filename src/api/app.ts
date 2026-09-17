import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Prisma } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import { generateSecret } from '../core/signing.js';
import { EndpointUrlError, assertEndpointUrlAllowed } from '../core/url-guard.js';
import { db } from '../db.js';
import { env } from '../env.js';
import { enqueueDelivery } from '../queue.js';
import { bearerFrom, constantTimeEqual, generateApiKey, hashApiKey } from './keys.js';

/**
 * The HTTP API. Schemas are TypeBox, which gives request validation, static
 * types and the OpenAPI document from one definition -- there is no separate
 * spec to drift out of date.
 *
 * Two principals: the admin key (env) creates applications; an application's
 * own key does everything else, scoped to that application. Every query
 * below takes applicationId from the authenticated key, never from the URL
 * or body, so an id guessed from another application returns 404.
 */

const Uuid = Type.String({ format: 'uuid' });
const Iso = Type.String({ format: 'date-time' });

const EndpointBody = Type.Object({
  url: Type.String({ format: 'uri', description: 'https URL the service POSTs to. Screened against private address space.' }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  eventTypes: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: 'Filter. Empty or omitted means every event type.' })),
});

const EndpointView = Type.Object({
  id: Uuid,
  url: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  eventTypes: Type.Array(Type.String()),
  enabled: Type.Boolean(),
  disabledReason: Type.Union([Type.String(), Type.Null()]),
  consecutiveFailures: Type.Integer(),
  createdAt: Iso,
});

const MessageBody = Type.Object({
  eventType: Type.String({ minLength: 1, maxLength: 200, examples: ['order.created'] }),
  payload: Type.Unknown({ description: 'Any JSON. Delivered under "data" in the signed envelope.' }),
});

const MessageView = Type.Object({
  id: Uuid,
  eventType: Type.String(),
  createdAt: Iso,
  deliveries: Type.Array(Type.Object({ id: Uuid, endpointId: Uuid, status: Type.String() })),
});

const DeliveryView = Type.Object({
  id: Uuid,
  messageId: Uuid,
  endpointId: Uuid,
  status: Type.String(),
  attemptCount: Type.Integer(),
  nextAttemptAt: Type.Union([Iso, Type.Null()]),
  attempts: Type.Array(
    Type.Object({
      number: Type.Integer(),
      responseStatus: Type.Union([Type.Integer(), Type.Null()]),
      error: Type.Union([Type.String(), Type.Null()]),
      durationMs: Type.Integer(),
      at: Iso,
    }),
  ),
});

const Problem = Type.Object({ error: Type.String() });

declare module 'fastify' {
  interface FastifyRequest {
    applicationId: string;
  }
}

async function authenticateApplication(request: FastifyRequest): Promise<void> {
  const key = bearerFrom(request.headers.authorization);
  if (key === undefined) throw Object.assign(new Error('Missing bearer token.'), { statusCode: 401 });

  const application = await db.application.findUnique({ where: { apiKeyHash: hashApiKey(key) }, select: { id: true } });
  if (application === null) throw Object.assign(new Error('Invalid API key.'), { statusCode: 401 });
  request.applicationId = application.id;
}

function authenticateAdmin(request: FastifyRequest): void {
  const key = bearerFrom(request.headers.authorization);
  if (key === undefined || !constantTimeEqual(key, env.ADMIN_API_KEY)) {
    throw Object.assign(new Error('Admin key required.'), { statusCode: 401 });
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env['NODE_ENV'] !== 'test', bodyLimit: 1_048_576 }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'hookrelay',
        version: '0.1.0',
        description:
          'Outbound webhook delivery. Publish a message; every enabled endpoint subscribed to its event type receives a signed POST, retried on a fixed schedule, dead-lettered when exhausted, replayable on demand.',
      },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, _request, reply) => {
    if (error instanceof EndpointUrlError) return reply.status(422).send({ error: error.message });
    if (error.validation !== undefined) return reply.status(400).send({ error: error.message });
    const status = error.statusCode ?? 500;
    // Internal errors are logged with detail and returned without it.
    if (status >= 500) app.log.error(error);
    return reply.status(status).send({ error: status >= 500 ? 'Internal error.' : error.message });
  });

  app.get('/health', { schema: { tags: ['system'], security: [] } }, () => ({ ok: true }));

  // --- applications (admin) ---------------------------------------------

  app.post(
    '/applications',
    {
      schema: {
        tags: ['applications'],
        summary: 'Create an application and its API key (admin)',
        body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }) }),
        response: { 201: Type.Object({ id: Uuid, name: Type.String(), apiKey: Type.String({ description: 'Shown once. Store it.' }) }), 401: Problem },
      },
      preHandler: (request, _reply, done) => {
        authenticateAdmin(request);
        done();
      },
    },
    async (request, reply) => {
      const apiKey = generateApiKey();
      const application = await db.application.create({ data: { name: request.body.name, apiKeyHash: hashApiKey(apiKey) } });
      return reply.status(201).send({ id: application.id, name: application.name, apiKey });
    },
  );

  // --- endpoints ----------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/require-await -- fastify plugins are async by contract
  await app.register(async (child) => {
    // The type provider does not flow into a plugin's child instance on its
    // own; without this every request.body below is unknown.
    const scoped = child.withTypeProvider<TypeBoxTypeProvider>();
    scoped.addHook('preHandler', authenticateApplication);

    scoped.post('/endpoints', { schema: { tags: ['endpoints'], summary: 'Register an endpoint', body: EndpointBody, response: { 201: Type.Intersect([EndpointView, Type.Object({ secret: Type.String({ description: 'Standard Webhooks secret. Shown once.' }) })]), 422: Problem } } }, async (request, reply) => {
      const url = await assertEndpointUrlAllowed(request.body.url, { allowInsecure: env.ALLOW_INSECURE_ENDPOINTS });
      const secret = generateSecret();
      const endpoint = await db.endpoint.create({
        data: {
          applicationId: request.applicationId,
          url: url.href,
          description: request.body.description ?? null,
          eventTypes: request.body.eventTypes ?? [],
          secrets: [secret],
        },
      });
      return reply.status(201).send({ ...view(endpoint), secret });
    });

    scoped.get('/endpoints', { schema: { tags: ['endpoints'], summary: 'List endpoints', response: { 200: Type.Array(EndpointView) } } }, async (request) => {
      const endpoints = await db.endpoint.findMany({ where: { applicationId: request.applicationId }, orderBy: { createdAt: 'asc' } });
      return endpoints.map(view);
    });

    scoped.get('/endpoints/:id', { schema: { tags: ['endpoints'], params: Type.Object({ id: Uuid }), response: { 200: EndpointView, 404: Problem } } }, async (request, reply) => {
      const endpoint = await db.endpoint.findFirst({ where: { id: request.params.id, applicationId: request.applicationId } });
      return endpoint === null ? reply.status(404).send({ error: 'Endpoint not found.' }) : view(endpoint);
    });

    scoped.patch(
      '/endpoints/:id',
      { schema: { tags: ['endpoints'], summary: 'Update, enable or disable an endpoint', params: Type.Object({ id: Uuid }), body: Type.Partial(Type.Intersect([EndpointBody, Type.Object({ enabled: Type.Boolean() })])), response: { 200: EndpointView, 404: Problem, 422: Problem } } },
      async (request, reply) => {
        const existing = await db.endpoint.findFirst({ where: { id: request.params.id, applicationId: request.applicationId } });
        if (existing === null) return reply.status(404).send({ error: 'Endpoint not found.' });

        const url = request.body.url === undefined ? undefined : (await assertEndpointUrlAllowed(request.body.url, { allowInsecure: env.ALLOW_INSECURE_ENDPOINTS })).href;
        const endpoint = await db.endpoint.update({
          where: { id: existing.id },
          data: {
            ...(url === undefined ? {} : { url }),
            ...(request.body.description === undefined ? {} : { description: request.body.description }),
            ...(request.body.eventTypes === undefined ? {} : { eventTypes: request.body.eventTypes }),
            // Re-enabling by hand resets the breaker; the operator has judged
            // the receiver fixed.
            ...(request.body.enabled === undefined ? {} : { enabled: request.body.enabled, disabledReason: null, consecutiveFailures: request.body.enabled ? 0 : existing.consecutiveFailures }),
          },
        });
        return view(endpoint);
      },
    );

    scoped.post('/endpoints/:id/rotate-secret', { schema: { tags: ['endpoints'], summary: 'Add a new signing secret; the previous one keeps signing for 24h', params: Type.Object({ id: Uuid }), response: { 200: Type.Object({ secret: Type.String() }), 404: Problem } } }, async (request, reply) => {
      const existing = await db.endpoint.findFirst({ where: { id: request.params.id, applicationId: request.applicationId } });
      if (existing === null) return reply.status(404).send({ error: 'Endpoint not found.' });
      const secret = generateSecret();
      // Newest first; the worker signs with all of them. Retiring the old one
      // is a scheduled job's concern and is not built yet (see README).
      await db.endpoint.update({ where: { id: existing.id }, data: { secrets: [secret, ...existing.secrets].slice(0, 2) } });
      return { secret };
    });

    scoped.delete('/endpoints/:id', { schema: { tags: ['endpoints'], params: Type.Object({ id: Uuid }), response: { 204: Type.Null(), 404: Problem } } }, async (request, reply) => {
      const result = await db.endpoint.deleteMany({ where: { id: request.params.id, applicationId: request.applicationId } });
      return result.count === 0 ? reply.status(404).send({ error: 'Endpoint not found.' }) : reply.status(204).send(null);
    });

    // --- messages ---------------------------------------------------------

    scoped.post(
      '/messages',
      {
        schema: {
          tags: ['messages'],
          summary: 'Publish a message to every subscribed endpoint',
          description: 'Send an Idempotency-Key header to make the request safe to retry: a repeat with the same key returns the original message and publishes nothing.',
          headers: Type.Object({ 'idempotency-key': Type.Optional(Type.String({ minLength: 1, maxLength: 255 })) }),
          body: MessageBody,
          response: { 201: MessageView, 200: MessageView },
        },
      },
      async (request, reply) => {
        const rawKey: unknown = request.headers['idempotency-key'];
        const idempotencyKey = typeof rawKey === 'string' ? rawKey : null;

        if (idempotencyKey !== null) {
          const existing = await db.message.findUnique({
            where: { applicationId_idempotencyKey: { applicationId: request.applicationId, idempotencyKey } },
            include: { deliveries: { select: { id: true, endpointId: true, status: true } } },
          });
          if (existing !== null) return reply.status(200).send(messageView(existing));
        }

        const endpoints = await db.endpoint.findMany({
          where: { applicationId: request.applicationId, enabled: true },
          select: { id: true, eventTypes: true },
        });
        const targets = endpoints.filter((endpoint) => endpoint.eventTypes.length === 0 || endpoint.eventTypes.includes(request.body.eventType));

        const message = await db.message.create({
          data: {
            applicationId: request.applicationId,
            eventType: request.body.eventType,
            payload: request.body.payload as Prisma.InputJsonValue,
            idempotencyKey,
            deliveries: { create: targets.map((endpoint) => ({ applicationId: request.applicationId, endpointId: endpoint.id, nextAttemptAt: new Date() })) },
          },
          include: { deliveries: { select: { id: true, endpointId: true, status: true } } },
        });

        // Enqueued after the commit, so a delivery job can never run for a
        // row that does not exist yet.
        await Promise.all(message.deliveries.map((delivery) => enqueueDelivery(delivery.id, 1)));

        return reply.status(201).send(messageView(message));
      },
    );

    scoped.get('/messages/:id', { schema: { tags: ['messages'], params: Type.Object({ id: Uuid }), response: { 200: MessageView, 404: Problem } } }, async (request, reply) => {
      const message = await db.message.findFirst({ where: { id: request.params.id, applicationId: request.applicationId }, include: { deliveries: { select: { id: true, endpointId: true, status: true } } } });
      return message === null ? reply.status(404).send({ error: 'Message not found.' }) : messageView(message);
    });

    // --- deliveries -------------------------------------------------------

    scoped.get(
      '/deliveries',
      { schema: { tags: ['deliveries'], summary: 'List deliveries, newest first', querystring: Type.Object({ status: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('succeeded'), Type.Literal('failed')])), endpointId: Type.Optional(Uuid), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })) }), response: { 200: Type.Array(DeliveryView) } } },
      async (request) => {
        const deliveries = await db.delivery.findMany({
          where: { applicationId: request.applicationId, ...(request.query.status === undefined ? {} : { status: request.query.status }), ...(request.query.endpointId === undefined ? {} : { endpointId: request.query.endpointId }) },
          include: { attempts: { orderBy: { number: 'asc' } } },
          orderBy: { createdAt: 'desc' },
          take: request.query.limit ?? 50,
        });
        return deliveries.map(deliveryView);
      },
    );

    scoped.get('/deliveries/:id', { schema: { tags: ['deliveries'], params: Type.Object({ id: Uuid }), response: { 200: DeliveryView, 404: Problem } } }, async (request, reply) => {
      const delivery = await db.delivery.findFirst({ where: { id: request.params.id, applicationId: request.applicationId }, include: { attempts: { orderBy: { number: 'asc' } } } });
      return delivery === null ? reply.status(404).send({ error: 'Delivery not found.' }) : deliveryView(delivery);
    });

    scoped.post(
      '/deliveries/:id/replay',
      { schema: { tags: ['deliveries'], summary: 'Re-attempt a failed delivery now', params: Type.Object({ id: Uuid }), response: { 202: DeliveryView, 404: Problem, 409: Problem } } },
      async (request, reply) => {
        const delivery = await db.delivery.findFirst({ where: { id: request.params.id, applicationId: request.applicationId }, include: { attempts: true } });
        if (delivery === null) return reply.status(404).send({ error: 'Delivery not found.' });
        if (delivery.status === 'pending') return reply.status(409).send({ error: 'Delivery is still in progress.' });

        const updated = await db.delivery.update({ where: { id: delivery.id }, data: { status: 'pending', nextAttemptAt: new Date() }, include: { attempts: { orderBy: { number: 'asc' } } } });
        await enqueueDelivery(delivery.id, delivery.attemptCount + 1);
        return reply.status(202).send(deliveryView(updated));
      },
    );
  });

  return app;
}

type EndpointRow = { id: string; url: string; description: string | null; eventTypes: string[]; enabled: boolean; disabledReason: string | null; consecutiveFailures: number; createdAt: Date };
function view(endpoint: EndpointRow): Static<typeof EndpointView> {
  return { ...endpoint, createdAt: endpoint.createdAt.toISOString() };
}

function messageView(message: { id: string; eventType: string; createdAt: Date; deliveries: Array<{ id: string; endpointId: string; status: string }> }): Static<typeof MessageView> {
  return { id: message.id, eventType: message.eventType, createdAt: message.createdAt.toISOString(), deliveries: message.deliveries };
}

function deliveryView(delivery: { id: string; messageId: string; endpointId: string; status: string; attemptCount: number; nextAttemptAt: Date | null; attempts: Array<{ number: number; responseStatus: number | null; error: string | null; durationMs: number; at: Date }> }): Static<typeof DeliveryView> {
  return {
    ...delivery,
    nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
    attempts: delivery.attempts.map((attempt) => ({ ...attempt, at: attempt.at.toISOString() })),
  };
}
