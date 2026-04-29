import { useEffect } from 'react'
import {
  formatTotalCost,
  isCostOutputDone,
  markCostOutputDone,
  saveCurrentSessionCosts,
} from './cost-tracker.js'
import { hasConsoleBillingAccess } from './utils/billing.js'
import { getGlobalConfig } from './utils/config.js'
import type { FpsMetrics } from './utils/fpsTracker.js'

export function useCostSummary(
  getFpsMetrics?: () => FpsMetrics | undefined,
): void {
  useEffect(() => {
    const f = () => {
      if (!isCostOutputDone() && hasConsoleBillingAccess() && getGlobalConfig().verbose) {
        markCostOutputDone()
        process.stdout.write('\n' + formatTotalCost() + '\n')
      }

      saveCurrentSessionCosts(getFpsMetrics?.())
    }
    process.on('exit', f)
    return () => {
      process.off('exit', f)
    }
  }, [])
}
