import { IRequest } from 'itty-router';

const DEFAULT_ALLOWED_ORIGIN = 'http://localhost:3000'

export const getCorsHeaders = (request: IRequest | Request, env: Env) => {
  const allowedHosts = (env.ALLOWED_HOSTS || DEFAULT_ALLOWED_ORIGIN).split(',')
  const origin: string = request.headers.get('Origin') || ''
  if (allowedHosts.includes(origin)) {
    return {
      'Access-Control-Allow-Methods': 'GET,POST,DELETE',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  } else {
    return {
      'Access-Control-Allow-Methods': '',
      'Access-Control-Allow-Origin': DEFAULT_ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': '',
    }
  }
}
