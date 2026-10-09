/**
 * Run logs (LAYOUT.md §5): the shared implementation in packages/logs
 * (`openRunLog`, `prune`), imported by path so dsd needs no install.
 */
export { openRunLog, prune } from '../../../packages/logs/index.mjs'
