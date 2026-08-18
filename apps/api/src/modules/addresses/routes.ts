import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { StandardErrors, ErrorResponse } from '@vendas-bot/shared'
import { resolveCustomerContext, toEwktPoint } from '../../lib/customer.js'
import {
  Address,
  AddressInput,
  AddressListQuery,
  AddressParams,
  AddressUpdate,
  DeliveryQuote,
  DeliveryQuoteInput,
} from './schemas.js'
import { listAddresses, quoteDelivery, setDefaultAddress, toAddress } from './service.js'

const addressRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /** Cotação de frete: pública, para o visitante simular antes de entrar. */
  app.post(
    '/public/delivery/quote',
    {
      schema: {
        tags: ['entrega'],
        description: 'Calcula a taxa de entrega conforme o modo do estabelecimento.',
        body: DeliveryQuoteInput,
        response: { 200: DeliveryQuote, 404: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (request) => {
      const { data: tenant } = await request.supabase
        .from('tenants')
        .select('id')
        .eq('slug', request.body.tenantSlug)
        .eq('is_active', true)
        .maybeSingle()

      if (!tenant) throw app.httpErrors.notFound('Estabelecimento não encontrado')

      return quoteDelivery(request.supabase, {
        tenantId: tenant.id,
        subtotal: request.body.subtotal,
        latitude: request.body.latitude,
        longitude: request.body.longitude,
        neighborhood: request.body.neighborhood,
        city: request.body.city,
      })
    },
  )

  app.get(
    '/addresses',
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ['entrega'],
        description: 'Endereços do cliente no estabelecimento informado.',
        querystring: AddressListQuery,
        response: { 200: Type.Array(Address), ...StandardErrors },
      },
    },
    async (request) => {
      const context = await resolveCustomerContext(
        request.supabase,
        request.query.tenantSlug,
        request.auth!.userId,
      )
      if (!context) return []
      return listAddresses(request.supabase, context.customerId)
    },
  )

  app.post(
    '/addresses',
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ['entrega'],
        description: 'Cadastra um endereço para o cliente autenticado.',
        body: AddressInput,
        response: { 201: Address, ...StandardErrors },
      },
    },
    async (request, reply) => {
      const context = await resolveCustomerContext(
        request.supabase,
        request.body.tenantSlug,
        request.auth!.userId,
      )
      if (!context) {
        throw app.httpErrors.forbidden('Complete o cadastro no estabelecimento antes de salvar endereços')
      }

      const { tenantSlug: _slug, latitude, longitude, isDefault, ...rest } = request.body

      const { data, error } = await request.supabase
        .from('customer_addresses')
        .insert({
          customer_id: context.customerId,
          tenant_id: context.tenantId,
          label: rest.label,
          street: rest.street,
          number: rest.number,
          complement: rest.complement ?? null,
          neighborhood: rest.neighborhood,
          city: rest.city,
          state: rest.state.toUpperCase(),
          zip_code: rest.zipCode ?? null,
          reference: rest.reference ?? null,
          location: toEwktPoint(latitude, longitude),
          is_default: false,
        })
        .select(
          'id, label, street, number, complement, neighborhood, city, state, zip_code, reference, location, is_default',
        )
        .single()

      if (error) throw app.httpErrors.badRequest(error.message)

      if (isDefault) {
        await setDefaultAddress(request.supabase, context.customerId, data.id)
        return reply.status(201).send({ ...toAddress(data), isDefault: true })
      }
      return reply.status(201).send(toAddress(data))
    },
  )

  app.patch(
    '/addresses/:id',
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ['entrega'],
        description: 'Atualiza um endereço do cliente.',
        params: AddressParams,
        body: AddressUpdate,
        response: { 200: Address, ...StandardErrors },
      },
    },
    async (request) => {
      const { latitude, longitude, isDefault: _ignored, zipCode, ...rest } = request.body

      const patch: Record<string, unknown> = { ...rest }
      if (zipCode !== undefined) patch.zip_code = zipCode
      if (typeof rest.state === 'string') patch.state = rest.state.toUpperCase()
      if (latitude !== undefined || longitude !== undefined) {
        patch.location = toEwktPoint(latitude, longitude)
      }

      const { data, error } = await request.supabase
        .from('customer_addresses')
        .update(patch)
        .eq('id', request.params.id)
        .select(
          'id, label, street, number, complement, neighborhood, city, state, zip_code, reference, location, is_default',
        )
        .maybeSingle()

      if (error) throw app.httpErrors.badRequest(error.message)
      if (!data) throw app.httpErrors.notFound('Endereço não encontrado')
      return toAddress(data)
    },
  )

  app.post(
    '/addresses/:id/default',
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ['entrega'],
        description: 'Define o endereço padrão do cliente.',
        params: AddressParams,
        querystring: AddressListQuery,
        response: { 200: Type.Array(Address), ...StandardErrors },
      },
    },
    async (request) => {
      const context = await resolveCustomerContext(
        request.supabase,
        request.query.tenantSlug,
        request.auth!.userId,
      )
      if (!context) throw app.httpErrors.forbidden('Cliente sem cadastro neste estabelecimento')

      await setDefaultAddress(request.supabase, context.customerId, request.params.id)
      return listAddresses(request.supabase, context.customerId)
    },
  )

  app.delete(
    '/addresses/:id',
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ['entrega'],
        description: 'Remove um endereço do cliente.',
        params: AddressParams,
        response: { 204: Type.Null(), ...StandardErrors },
      },
    },
    async (request, reply) => {
      const { error } = await request.supabase
        .from('customer_addresses')
        .delete()
        .eq('id', request.params.id)
      if (error) throw app.httpErrors.badRequest(error.message)
      return reply.status(204).send(null)
    },
  )
}

export default addressRoutes
