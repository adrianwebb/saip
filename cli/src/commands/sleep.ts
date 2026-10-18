import { Command } from 'commander'

export const sleepCommand = new Command('sleep')
  .description('Stop inference gateway and start training gateway')
  .option('-b, --bucket <name>', 'Override R2 bucket name')
  .action(async (options) => {
    console.log(`[saip] Switching to SLEEP mode...`)
    console.log(`[saip] TODO: Stop inference compose, start training compose`)
    if (options.bucket) {
      console.log(`[saip] Using bucket override: ${options.bucket}`)
    }
    // Future implementation:
    // 1. Validate saip.yaml and load .env
    // 2. docker compose -f inference/docker-compose.yml down
    // 3. docker compose -f training/docker-compose.yml up -d
    // 4. Report status
  })
