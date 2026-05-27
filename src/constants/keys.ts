import { isEnvTruthy } from '../utils/envUtils.js'

// Lazy read so ENABLE_GROWTHBOOK_DEV from globalSettings.env (applied after
// module load) is picked up. USER_TYPE is a build-time define so it's safe.
export function getGrowthBookClientKey(): string {
  return process.env.USER_TYPE === 'ant'
    ? isEnvTruthy(process.env.ENABLE_GROWTHBOOK_DEV)
      ? process.env.GROWTHBOOK_DEV_KEY || ''
      : process.env.GROWTHBOOK_PROD_KEY || ''
    : ''
}
