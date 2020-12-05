require('dotenv').config();

import AutoStaker from './AutoStaker';

async function main() {
  const autoStaker = new AutoStaker();

  // Graceful shutdown
  let shutdown = false;

  const gracefulShutdown = () => {
    shutdown = true;
  };

  process.once('SIGINT', gracefulShutdown);
  process.once('SIGTERM', gracefulShutdown);

  while (!shutdown) {
    await autoStaker.process().catch((err) => {
      console.log(err);
      process.exit(-1);
    });

    await sleep(4000000);
  }

  process.exit(0);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(`Exit with ${err}`);
});
