import { Mirror } from '@mirror-protocol/mirror.js';
import {
  MnemonicKey,
  LCDClient,
  MsgExecuteContract,
  Wallet,
  isTxError,
  Int,
  int
} from '@terra-money/terra.js';

const MNEMONIC = process.env.MNEMONIC;
const MNEMONIC_INDEX = parseInt(process.env.MNEMONIC_INDEX || '0');
const COIN_TYPE = parseInt(process.env.COIN_TYPE as string);

export default class AutoStaker {
  wallet: Wallet;
  mirror: Mirror;

  constructor() {
    const key = new MnemonicKey({
      mnemonic: MNEMONIC,
      index: MNEMONIC_INDEX,
      coinType: COIN_TYPE
    });

    const lcd = new LCDClient({
      URL: 'https://lcd.terra.dev',
      chainID: 'columbus-4',
      gasAdjustment: '1.2',
      gasPrices: '0.0015uusd'
    });

    this.mirror = new Mirror({
      key,
      lcd
    });

    this.wallet = new Wallet(lcd, key);
  }

  async execute(msgs: Array<MsgExecuteContract>) {
    const tx = await this.wallet.createAndSignTx({
      msgs
    });

    const result = await this.wallet.lcd.tx.broadcastSync(tx);

    if (isTxError(result)) {
      console.log(JSON.stringify(result));
      throw new Error(
        `Error while executing: ${result.code} - ${result.raw_log}`
      );
    }

    await this.pollingTx(result.txhash);
  }

  async pollingTx(txHash: string) {
    let isFound = false;

    while (!isFound) {
      try {
        await this.wallet.lcd.tx.txInfo(txHash);
        isFound = true;
      } catch (err) {
        await sleep(3000);
      }
    }
  }

  async process() {
    const mirrorToken = this.mirror.assets['MIR'];

    const mirrorTokenAddr = mirrorToken.token.contractAddress as string;
    const poolInfo = await this.mirror.staking.getPoolInfo(mirrorTokenAddr);
    const rewardInfoResponse = await this.mirror.staking.getRewardInfo(
      this.wallet.key.accAddress
    );

    // if no rewards exists, skip procedure
    if (poolInfo.reward_index == rewardInfoResponse.reward_infos[0].index) {
      return;
    }

    console.log('Claim Rewards');
    await this.execute([this.mirror.staking.withdraw()]);

    const balanceResponse = await this.mirror.mirrorToken.getBalance();
    const balance = new Int(balanceResponse.balance);
    const sellAmount = new Int(balance.divToInt(2));
    const mirrorAmount = balance.sub(sellAmount);

    console.log('Swap half rewards to UST');
    await this.execute([
      mirrorToken.pair.swap(
        {
          info: {
            token: {
              contract_addr: mirrorToken.token.contractAddress as string
            }
          },
          amount: new Int(sellAmount).toString()
        },
        {
          offer_token: mirrorToken.token
        }
      )
    ]);

    const pool = await mirrorToken.pair.getPool();
    const uusdAmount = mirrorAmount
      .mul(pool.assets[0].amount)
      .divToInt(pool.assets[1].amount);

    console.log('Provide Liquidity');
    await this.execute([
      mirrorToken.token.increaseAllowance(
        mirrorToken.pair.contractAddress as string,
        new Int(mirrorAmount).toString()
      ),
      mirrorToken.pair.provideLiquidity([
        {
          info: {
            token: {
              contract_addr: mirrorToken.token.contractAddress as string
            }
          },
          amount: new Int(mirrorAmount).toString()
        },
        {
          info: {
            native_token: {
              denom: 'uusd'
            }
          },
          amount: new Int(uusdAmount).toString()
        }
      ])
    ]);

    const lpTokenBlanace = await mirrorToken.lpToken.getBalance();

    console.log('Stake LP token');
    await this.execute([
      this.mirror.staking.bond(
        mirrorTokenAddr,
        lpTokenBlanace.balance,
        mirrorToken.lpToken
      )
    ]);

    console.log('Done');
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
