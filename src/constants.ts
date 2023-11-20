export const models = {
  'gpt-3.5-turbo': 'GPT-3.5 Turbo (4k context)',
  'gpt-3.5-turbo-16k': 'GPT-3.5 Turbo (16k context)',
  'gpt-4': 'GPT-4 (8k context)',
  'gpt-4-1106-preview': 'GPT-4 Turbo (128k context)',
  'gpt-4-vision-preview': 'GPT-4V (128k context)',
}

export const defaultModelLimits: { [model in keyof typeof models]: { minute: number | null, day: number | null } } = {
  'gpt-3.5-turbo': {
    minute: 10000,
    day: null,
  },
  'gpt-3.5-turbo-16k': {
    minute: 10000,
    day: null,
  },
  'gpt-4': {
    minute: 2500,
    day: null,
  },
  'gpt-4-1106-preview': {
    minute: 4000,
    day: 25000,
  },
  'gpt-4-vision-preview': {
    minute: 2500,
    day: 10000,
  },
}

export const imageModels = {
  'dall-e-3': {
    name: 'DALL·E 3',
    resolutions: ['1024x1024', '1024x1792', '1792x1024'],
  },
  'dall-e-2': {
    name: 'DALL·E 2',
    resolutions: ['256x256', '512x512', '1024x1024'],
  },
}

export const defaultImageModelLimits: { [model in keyof typeof imageModels]: { minute: number | null, day: number | null } } = {
  'dall-e-2': {
    minute: 0,
    day: 0,
  },
  'dall-e-3': {
    minute: 0,
    day: 0,
  },
}

export type InviteCode = {
  used: number;
  limit: number;
}
