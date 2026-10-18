#!/usr/bin/env node

/**
 * SAIP CLI — manage inference and training services
 *
 * Commands:
 *   awake   Stop training, start inference
 *   sleep   Stop inference, start training
 *   down    Shut down all services
 *   status  Show runtime state and vitals
 */

import { Command } from 'commander'
import { awakeCommand } from './commands/awake.js'
import { sleepCommand } from './commands/sleep.js'
import { downCommand } from './commands/down.js'
import { statusCommand } from './commands/status.js'

const program = new Command()

program
  .name('saip')
  .description('Simple AI Platform — manage inference and training services')
  .version('0.1.0')

program.addCommand(awakeCommand)
program.addCommand(sleepCommand)
program.addCommand(downCommand)
program.addCommand(statusCommand)

program.parse()
