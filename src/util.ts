import { IRequest } from 'itty-router';
import { Env } from './index';
import Stripe from 'stripe';
import { defaultImageModelLimits, defaultModelLimits, imageModels, models } from './constants';
import { getTokenFromGCPServiceAccount } from '@sagi.io/workers-jwt';
import OpenAI from 'openai';
import ChatCompletionMessageParam = OpenAI.ChatCompletionMessageParam;
import { ChatCompletionContentPart } from 'openai/src/resources/chat/completions';

const DEFAULT_ALLOWED_ORIGIN = 'http://localhost:3000'

export const getCorsHeaders = (request: IRequest | Request, env: Env) => {
  const allowedHosts = (env.ALLOWED_HOSTS || DEFAULT_ALLOWED_ORIGIN).split(',')
  const origin: string = request.headers.get('Origin') || ''
  if (allowedHosts.includes(origin)) {
    return {
      'Access-Control-Allow-Methods': 'GET,POST,DELETE',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Credentials': 'true',
    }
  } else {
    return {
      'Access-Control-Allow-Methods': '',
      'Access-Control-Allow-Origin': DEFAULT_ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': '',
      'Access-Control-Allow-Credentials': 'false', // not recommended to do this
    }
  }
}

export const getStripe = (env: Env) => {
  if (!env?.STRIPE_KEY) throw new Error('STRIPE_KEY is missing')
  return new Stripe(env.STRIPE_KEY, {
    httpClient: Stripe.createFetchHttpClient(), // ensure we use a Fetch client, and not Node's `http`
  })
}

export const isObject = (item: any): boolean => item && typeof item === 'object' && !Array.isArray(item)

export const mergeDeep = <T extends { [k: string]: any }, U>(target: T, ...sources: U[]): T & U => {
  if (!sources.length) {
    return target as T & U
  }
  const source = sources.shift()

  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} })
        mergeDeep(target[key], source[key])
      } else {
        Object.assign(target, { [key]: source[key] })
      }
    }
  }

  return mergeDeep(target, ...sources)
}

export const getUnsafeObjectKeys = <O extends {}>(object: O) => Object.keys(object) as Array<keyof O>

export const associateArrayWith = <K extends string | number | symbol, V>(array: Array<K>, action: (k: K) => V): Record<K, V> => {
  const record: any = {}
  array.forEach(k => record[k] = action(k))
  return record
}

export const associateObjectKeyWith = <K extends {}, V>(object: K, action: (k: keyof K) => V): { [key in keyof K]: V } => {
  const record: any = {}
  ;(Object.keys(object) as Array<keyof K>).forEach(k => record[k] = action(k))
  return record
}

export const getDefaultUserData = () => ({
  active: false,
  invite_code: '',
  stripe_customer_id: '',
  allow_retrieval_tool: true,
  limits: defaultModelLimits,
  image_limits: defaultImageModelLimits,
  // TODO: use durable objects
  used: {...associateObjectKeyWith(models, () => ({ minute: 0, day: 0 })), file: { minute: 0, day: 0 } },
  image_used: associateObjectKeyWith(imageModels, () => ({ minute: 0, day: 0 })),
  usage_text_since_last_record: {...associateObjectKeyWith(models, () => 0), file: 0 },
  usage_image_since_last_record: associateObjectKeyWith(imageModels, () => 0),
  default_instruction: '',
  created_at: Date.now(),
})

export const getUserDataById = async (env: Env, userId: string) => {
  const data = await env.KV_USERS.get<ReturnType<typeof getDefaultUserData>>(userId, { type: 'json' })
  if (!data) return getDefaultUserData()
  return mergeDeep(getDefaultUserData(), data)
}

export const getSubscriptionItem = (subscriptions: Stripe.ApiList<Stripe.Subscription>, lookupKey: string): Stripe.SubscriptionItem | null => {
  for (const subscription of subscriptions.data) {
    for (const subscriptionItem of subscription.items.data) {
      const priceLookupKey = subscriptionItem.price.lookup_key
      if (!priceLookupKey) continue
      const split = priceLookupKey.split(',')
      if (split.includes(lookupKey)) {
        return subscriptionItem
      }
    }
  }
  return null
}

export const calculateLength = (value: any): number => {
  if (typeof value === 'string') {
    return value.length
  } else if (Array.isArray(value)) {
    return value.map(e => calculateLength(e)).reduce((a, b) => a + b)
  } else if (typeof value === 'object') {
    if (typeof value.text === 'string') {
      return value.text.length
    } else if (typeof value.text === 'object') {
      return calculateLength(value.text)
    } else if (typeof value.value === 'string') {
      return value.value.length
    } else if (value.image_file) {
      return 1000
    } else if (value.content) {
      return calculateLength(value.content)
    } else {
      return 0
    }
  } else {
    return 0
  }
}

export const getGoogleToken = async (env: Env) => {
  const aud = 'https://bigquery.googleapis.com/'
  return await getTokenFromGCPServiceAccount({ serviceAccountJSON: JSON.parse(env.BIGQUERY_SERVICE_ACCOUNT), aud })
}

export type UsageTable = {
  user_id: string
  stripe_customer_id: string | null
  action: string
  timestamp: number
  model: string | null
  count: number | null
  extra: string | null
}

const insertBQRecordRaw = async (env: Env, tableName: string, rows: any[]) => {
  return await fetch(`${env.BIGQUERY_URL}tables/${tableName}/insertAll`, {
    method: 'POST',
    body: JSON.stringify({
      kind: "bigquery#tableDataInsertAllResponse",
      rows: rows.map(e => ({ insertId: crypto.randomUUID(), json: e })),
    }),
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${await getGoogleToken(env)}`,
    },
  })
}

export const insertBQRecordUsage = async (
  env: Env,
  user_id: string,
  stripe_customer_id: string | null,
  action: string,
  model: string | null = null,
  count: number | null = null,
  extra: string | null = null,
) => insertBQRecordRaw(env, 'usage', [{
  user_id,
  stripe_customer_id,
  action,
  timestamp: Date.now(),
  model,
  count,
  extra,
} as UsageTable])

export const insertBQRecordUsageAll = async (env: Env, data: UsageTable[]) =>
  insertBQRecordRaw(env, 'usage', data)

export const redirectCors = (request: IRequest, env: Env, url: string, status: number) =>
  new Response(null, {
    status: status,
    headers: {
      Location: url,
      ...getCorsHeaders(request, env),
    }
  })

export const getDiscordMessageChain = async (selfId: string, botToken: string, instruction: string | null, message: any): Promise<Array<ChatCompletionMessageParam>> => {
  const array: Array<ChatCompletionMessageParam> = []
  const messages = await fetch(`https://discord.com/api/v10/channels/${message.channel_id}/messages?before=${message.id}`, {
    headers: {Authorization: 'Bot ' + botToken},
  }).then(res => res.json()) as any[]
  let currentMessage = message
  array.push({role: 'user', content: getDiscordMessageToChatCompletionMessage(currentMessage)})
  while (currentMessage?.referenced_message) {
    currentMessage = messages.find(m => m.id === currentMessage.referenced_message?.id)
    if (currentMessage.application_id === selfId || currentMessage.author.id === selfId) {
      array.push({role: 'assistant', content: currentMessage.content})
    } else {
      array.push({role: 'user', content: getDiscordMessageToChatCompletionMessage(currentMessage)})
    }
  }
  array.push({role: 'system', content: instruction})
  return array.reverse()
}

export const getDiscordMessageToChatCompletionMessage = (message: any): Array<ChatCompletionContentPart> => {
  const array = new Array<ChatCompletionContentPart>()
  array.push({type: 'text', text: message.content})
  if (message.attachments) {
    for (const attachment of message.attachments) {
      array.push({type: 'image_url', image_url: attachment.url})
    }
  }
  return array
}
