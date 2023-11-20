import apiRouter, { incrementUsage } from './router';
import {
  calculateLength,
  getCorsHeaders,
  getStripe,
  getSubscriptionItem,
  getUnsafeObjectKeys,
  getUserDataById, insertBQRecordUsage
} from './util';

import { KVNamespace } from '@cloudflare/workers-types'
import { models } from './constants';
import OpenAI from 'openai/index';

export interface Env {
  KV_GITHUB: KVNamespace;
  KV_DISCORD: KVNamespace;
  KV_USERS: KVNamespace;
  KV_SESSIONS: KVNamespace;
  KV_INVITE_CODES: KVNamespace;

  ALLOWED_HOSTS: string;
  OPENAI_TOKEN: string;
  ASSISTANT_ID: string;
  CUSTOM_SEARCH_KEY: string;
  CUSTOM_SEARCH_ID: string;
  STRIPE_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_REDIRECT_URL: string;
  REQUIRE_INVITE: string | boolean;
  TOS_URL: string;
  PRIVACY_POLICY_URL: string;
  PRICING_URL: string;
  SCT_URL: string;
  BIGQUERY_URL: string; // https://bigquery.googleapis.com/bigquery/v2/projects/<project name>/datasets/<dataset name>/
  BIGQUERY_SERVICE_ACCOUNT: string;
}

export type KeyFilter<T, V> = {
  [K in keyof T]: T[K] extends V ? K : never;
}[keyof T]

export default {
  // all routes starts with /api, so you can use Workers Routes to attach to existing application
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // console.log(request)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: getCorsHeaders(request, env)
      })
    }
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) {
      return apiRouter.handle(request, env)
    }

    return new Response(null, { status: 404 })
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const start = Date.now()
    try {
      const list: string[] | null = await env.KV_USERS.get('__usage', { type: 'json' })
      if (list && event.cron === '* * * * *') {
        for (const userId of list) {
          const userData = await getUserDataById(env, userId)
          if (!userData) continue
          getUnsafeObjectKeys(userData.used).forEach(k => userData.used[k].minute = 0)
          getUnsafeObjectKeys(userData.image_used).forEach(k => userData.image_used[k].minute = 0)
          await env.KV_USERS.put(userId, JSON.stringify(userData))
        }
      }
      if (event.cron === '0 0 * * *') {
        const dailyList: string[] | null = await env.KV_USERS.get('__usage_daily', { type: 'json' })
        if (dailyList) {
          for (const userId of dailyList) {
            const userData = await getUserDataById(env, userId)
            if (!userData) continue
            getUnsafeObjectKeys(userData.used).forEach(k => userData.used[k].day = 0)
            getUnsafeObjectKeys(userData.image_used).forEach(k => userData.image_used[k].day = 0)
            await env.KV_USERS.put(userId, JSON.stringify(userData))
          }
          await env.KV_USERS.delete('__usage_daily')
        }
      } else if (event.cron === '*/5 * * * *') {
        const trackedRuns: string[] | null = await env.KV_USERS.get('__tracked_runs', { type: 'json' })
        await env.KV_USERS.delete('__tracked_runs')
        if (trackedRuns) {
          const openAi = new OpenAI({ apiKey: env.OPENAI_TOKEN })
          const notDoneRuns = new Array<string>()
          for (const trackedRun of trackedRuns) {
            const [user_id, thread_id, run_id, usageString] = trackedRun.split('|')
            const userData = await getUserDataById(env, user_id)
            if (!userData) continue
            try {
              const retrievedRun = await openAi.beta.threads.runs.retrieve(thread_id, run_id)
              if (retrievedRun.status === 'completed') {
                const steps = await openAi.beta.threads.runs.steps.list(retrievedRun.thread_id, retrievedRun.id)
                let count = 0
                for await (const step of steps) {
                  if (step.type === 'message_creation' && step.step_details.type === 'message_creation') {
                    const messageId = step.step_details.message_creation.message_id
                    const message = await openAi.beta.threads.messages.retrieve(step.thread_id, messageId)
                    count += calculateLength(message.content)
                  }
                }
                await insertBQRecordUsage(
                  env,
                  user_id,
                  userData.stripe_customer_id,
                  'assistant_message_creation_by_assistant',
                  retrievedRun.model,
                  count,
                  JSON.stringify({
                    thread_id: retrievedRun.thread_id,
                    run_id: retrievedRun.id,
                  }),
                )
                await incrementUsage(env, retrievedRun.model as keyof typeof models, user_id, userData, count + parseInt(usageString))
              } else {
                notDoneRuns.push(trackedRun)
              }
            } catch (e: any) {
              console.error(e.stack || e)
            }
          }
          await env.KV_USERS.put('__tracked_runs', JSON.stringify(notDoneRuns))
        }
      } else if (event.cron === '*/30 * * * *') {
        const stripe = getStripe(env)
        if (list) {
          for (const userId of list) {
            const userData = await getUserDataById(env, userId)
            if (!userData || !userData.stripe_customer_id || userData.stripe_customer_id === 'DONT_CHARGE_ME') continue
            const subscription = await stripe.subscriptions.list({
              customer: userData.stripe_customer_id,
            })
            for (const model of getUnsafeObjectKeys(userData.usage_text_since_last_record)) {
              const used = userData.usage_text_since_last_record[model]
              const quantity = Math.floor(used / 1000)
              if (quantity < 1) continue
              const item = getSubscriptionItem(subscription, model)
              if (item) {
                await stripe.subscriptionItems.createUsageRecord(item.id, { quantity })
                userData.usage_text_since_last_record[model] %= 1000
              }
            }
            for (const model of getUnsafeObjectKeys(userData.usage_image_since_last_record)) {
              const used = userData.usage_image_since_last_record[model]
              const quantity = Math.floor(used / 1000)
              if (quantity < 1) continue
              const item = getSubscriptionItem(subscription, model)
              if (item) {
                await stripe.subscriptionItems.createUsageRecord(item.id, { quantity })
                userData.usage_image_since_last_record[model] %= 1000
              }
            }
            await env.KV_USERS.put(userId, JSON.stringify(userData))
          }
        }
        await env.KV_USERS.delete('__usage')
      }
    } catch (e: any) {
      console.error(e.stack || e)
    } finally {
      const total = Date.now() - start
      console.log(`Cron of ${event.cron} done in ${total} ms`)
    }
  }
}
