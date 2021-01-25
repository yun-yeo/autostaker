import { Mirror, AssetInfo } from '@mirror-protocol/mirror.js';
import {
  MnemonicKey,
  LCDClient,
  MsgExecuteContract,
  Wallet,
  isTxError,
  Int,
  Coin,
  StdFee,
  Coins
} from '@terra-money/terra.js';

const LCD_URL = process.env.LCD_URL || 'https://lcd.terra.dev';

const MNEMONIC = process.env.MNEMONIC as string;
const MNEMONIC_INDEX = parseInt(process.env.MNEMONIC_INDEX || '0');
const COIN_TYPE = parseInt(process.env.COIN_TYPE as string);

const TARGET_ASSET = process.env.TARGET_ASSET || 'MIR';

export default class AutoStaker {
  wallet: Wallet;
  mirror: Mirror;
  lcd: LCDClient;

  constructor() {
    const key = new MnemonicKey({
      mnemonic: MNEMONIC,
      index: MNEMONIC_INDEX,
      coinType: COIN_TYPE
    });

    const lcd = new LCDClient({
      URL: LCD_URL,
      chainID: 'columbus-4',
      gasPrices: new Coins({ uusd: 0.0015 }),
      gasAdjustment: 1.2
    });

    this.mirror = new Mirror({
      key,
      lcd
    });

    this.wallet = new Wallet(lcd, key);
    this.lcd = lcd;
  }

  async execute(msgs: Array<MsgExecuteContract>) {
    // Use static fee
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
    if (TARGET_ASSET === 'MIR') {
      await this.processMIR();
    } else {
      await this.processNonMIR();
    }
  }

  async processMIR() {
    const mirrorToken = this.mirror.assets['MIR'];

    const mirrorTokenAddr = mirrorToken.token.contractAddress as string;
    const poolInfo = await this.mirror.staking.getPoolInfo(mirrorTokenAddr);
    const rewardInfoResponse = await this.mirror.staking.getRewardInfo(
      this.wallet.key.accAddress,
      mirrorTokenAddr
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

  async processNonMIR() {
    const mirrorToken = this.mirror.assets['MIR'];
    const assetToken = this.mirror.assets[TARGET_ASSET];

    const assetTokenAddr = assetToken.token.contractAddress as string;
    const poolInfo = await this.mirror.staking.getPoolInfo(assetTokenAddr);
    const rewardInfoResponse = await this.mirror.staking.getRewardInfo(
      this.wallet.key.accAddress,
      assetTokenAddr
    );

    // if no rewards exists, skip procedure
    if (poolInfo.reward_index == rewardInfoResponse.reward_infos[0].index) {
      return;
    }

    console.log('Claim Rewards');
    await this.execute([this.mirror.staking.withdraw()]);

    const balanceResponse = await this.mirror.mirrorToken.getBalance();
    const balance = new Int(balanceResponse.balance);

    console.log('Swap rewards to UST');
    await this.execute([
      mirrorToken.pair.swap(
        {
          info: {
            token: {
              contract_addr: mirrorToken.token.contractAddress as string
            }
          },
          amount: new Int(balance).toString()
        },
        {
          offer_token: mirrorToken.token
        }
      )
    ]);

    console.log('Swap half UST to target asset');
    const uusdBalanceResponse = await this.lcd.bank.balance(
      this.wallet.key.accAddress
    );

    let pool = await assetToken.pair.getPool();
    const uusdPool = new Int(pool.assets[0].amount);
    const uusdBalance = (uusdBalanceResponse.get('uusd') as Coin).amount;

    // let swap_amount = sqrt(pool*(pool + deposit)) - pool
    const uusdSellAmount = new Int(
      uusdPool.mul(uusdPool.plus(uusdBalance)).sqrt().minus(uusdPool)
    );

    await this.execute([
      assetToken.pair.swap(
        {
          info: {
            native_token: {
              denom: 'uusd'
            }
          },
          amount: uusdSellAmount.toString()
        },
        {}
      )
    ]);

    const assetProvideAmount = new Int(
      (await assetToken.token.getBalance()).balance
    );

    pool = await assetToken.pair.getPool();
    const uusdProvideAmount = assetProvideAmount
      .mul(pool.assets[0].amount)
      .divToInt(pool.assets[1].amount);

    console.log('Provide Liquidity');
    await this.execute([
      assetToken.token.increaseAllowance(
        assetToken.pair.contractAddress as string,
        new Int(assetProvideAmount).toString()
      ),
      assetToken.pair.provideLiquidity([
        {
          info: {
            token: {
              contract_addr: assetToken.token.contractAddress as string
            }
          },
          amount: new Int(assetProvideAmount).toString()
        },
        {
          info: {
            native_token: {
              denom: 'uusd'
            }
          },
          amount: new Int(uusdProvideAmount).toString()
        }
      ])
    ]);

    const lpTokenBlanace = await assetToken.lpToken.getBalance();

    console.log('Stake LP token');
    await this.execute([
      this.mirror.staking.bond(
        assetTokenAddr,
        lpTokenBlanace.balance,
        assetToken.lpToken
      )
    ]);

    console.log('Done');
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
