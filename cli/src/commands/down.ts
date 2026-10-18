import { Command } from 'commander'

export const downCommand = new Command('down')
  .description('Shut down all SAIP services')
  .action(async () => {
    console.log(`[saip] Shutting down all services...`)
    console.log(`[saip] TODO: docker compose down for both services`)
    // Future implementation:
    // 1. docker compose -f inference/docker-compose.yml down
    // 2. docker compose -f training/docker-compose.yml down
    // 3. Report confirmation
  })
