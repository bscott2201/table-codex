// @ts-check
/**
 * @file tablecodex-sync.js
 * The single ESM entry point declared in module.json. It does the minimum at
 * module-evaluation time (install the early global + module-scope hooks) and
 * then registers the lifecycle hooks. All real work is deferred to the
 * appropriate Foundry hook inside bootstrap.js — nothing here touches game
 * globals at parse time.
 */

import { installModuleScope, registerLifecycle } from "./core/bootstrap.js";
import { logger } from "./core/logger.js";

logger.info("tablecodex-sync.js evaluated");

installModuleScope();
registerLifecycle();
