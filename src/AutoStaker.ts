const args = require('minimist')(process.argv.slice(2));

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

const LCD_URL =
  args.lcd == undefined
    ? process.env.LCD_URL || 'https://lcd.terra.dev'
    : args.lcd;

const MNEMONIC =
  process.env.MNEMONIC == '' ? args.mnemonic : process.env.MNEMONIC;

const MNEMONIC_INDEX = parseInt(process.env.MNEMONIC_INDEX || '0');
const COIN_TYPE = parseInt(process.env.COIN_TYPE || '330');
const CONTRACT_EXEC_DELAY_SEC = parseInt(
  process.env.CONTRACT_EXEC_DELAY_SEC || '15000'
);

const TARGET_ASSET = process.env.TARGET_ASSET || 'MIR';

export default class AutoStaker {
  wallet: Wallet;
  mirror: Mirror;
  lcd: LCDClient;
  assetTokenAddr: string;

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
    this.assetTokenAddr = '';
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
    await sleep(CONTRACT_EXEC_DELAY_SEC * 1000); // necessary to stagger contract execution so that various LB'd servers can be synced on the last transaction completed
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
    this.assetTokenAddr = mirrorToken.token.contractAddress as string;

    console.log(`============== ${new Date().toLocaleString()} ==============`);

    // if no rewards exists, skip procedure
    if (!(await this.rewardsToClaim())) return;

    console.log('Claim Rewards');
    await this.execute([this.mirror.staking.withdraw()]);

    const balanceResponse = await this.mirror.mirrorToken.getBalance();
    const balance = new Int(balanceResponse.balance);
    const sellAmount = new Int(balance.divToInt(1.9));
    const mirrorProvideAmount = balance.sub(sellAmount);
    console.log('  >> Wallet Mirror Balance:', toDecimal(balance));

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
        {}
      )
    ]);
    const pool = await mirrorToken.pair.getPool();
    console.log(
      `  >> ${toDecimal(sellAmount)} UST swapped to ${toDecimal(
        mirrorProvideAmount
      )} ${TARGET_ASSET}`
    );

    console.log('Provide Liquidity');
    const uusdProvideAmount = mirrorProvideAmount
      .mul(pool.assets[0].amount)
      .divToInt(pool.assets[1].amount);
    await this.execute([
      mirrorToken.token.increaseAllowance(
        mirrorToken.pair.contractAddress as string,
        new Int(mirrorProvideAmount).toString()
      ),
      mirrorToken.pair.provideLiquidity([
        {
          info: {
            token: {
              contract_addr: mirrorToken.token.contractAddress as string
            }
          },
          amount: new Int(mirrorProvideAmount).toString()
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
    console.log(
      `  >> Provided ${toDecimal(
        mirrorProvideAmount
      )}${TARGET_ASSET} & ${toDecimal(uusdProvideAmount)}UST`
    );

    console.log('Stake LP token');
    const lpTokenBalance = await mirrorToken.lpToken.getBalance();
    await this.execute([
      this.mirror.staking.bond(
        this.assetTokenAddr,
        lpTokenBalance.balance,
        mirrorToken.lpToken
      )
    ]);
    console.log(
      `  >> Staked ${toDecimal({
        d: [lpTokenBalance.balance]
      })} LP to ${TARGET_ASSET}-UST LP`
    );

    console.log('Done');
  }

  async processNonMIR() {
    const mirrorToken = this.mirror.assets['MIR'];
    const assetToken = this.mirror.assets[TARGET_ASSET];

    this.assetTokenAddr = assetToken.token.contractAddress as string;

    console.log(`============== ${new Date().toLocaleString()} ==============`);

    // if no rewards exists, skip procedure
    if (!(await this.rewardsToClaim())) return;

    console.log('Claim Rewards');
    await this.execute([this.mirror.staking.withdraw()]);
    const mirBalanceResponse = await this.mirror.mirrorToken.getBalance();
    const mirBalance = new Int(mirBalanceResponse.balance);
    console.log('  >> Wallet Mirror Balance:', toDecimal(mirBalance));

    console.log('Swap mirror rewards to UST');
    await this.execute([
      mirrorToken.pair.swap(
        {
          info: {
            token: {
              contract_addr: mirrorToken.token.contractAddress as string
            }
          },
          amount: new Int(mirBalance).toString()
        },
        {}
      )
    ]);
    const uusdBalanceResponse = await this.lcd.bank.balance(
      this.wallet.key.accAddress
    );
    const uusdBalance = (uusdBalanceResponse.get('uusd') as Coin).amount; // balance in wallet
    console.log('  >> Wallet UST Balance:', toDecimal(uusdBalance));

    console.log('Swap half UST to', TARGET_ASSET);
    const uusdSellAmount = (uusdBalanceResponse.get('uusd') as Coin)
      .div(2.1)
      .toIntCoin().amount; // sell a little bit less than half to leave money for tx fees
    const assetTokenBalance = new Int(
      (await assetToken.token.getBalance()).balance
    );
    if (toDecimal(assetTokenBalance) > 0) {
      throw new Error(
        'Process Failed: Please manually convert mAsset to UST in wallet'
      );
    }
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
    console.log(
      `  >> ${toDecimal(uusdSellAmount)} UST swapped to ${toDecimal(
        assetProvideAmount
      )} ${TARGET_ASSET}`
    );

    console.log('Providing Liquidity');
    const pool = await assetToken.pair.getPool();
    const uusdProvideAmount = assetProvideAmount
      .mul(pool.assets[0].amount)
      .divToInt(pool.assets[1].amount);
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
    console.log(
      `  >> Provided ${toDecimal(
        assetProvideAmount
      )}${TARGET_ASSET} & ${toDecimal(uusdProvideAmount)}UST`
    );

    console.log('Staking LP token');
    const lpTokenBalance = await assetToken.lpToken.getBalance();
    await this.execute([
      this.mirror.staking.bond(
        this.assetTokenAddr,
        lpTokenBalance.balance,
        assetToken.lpToken
      )
    ]);
    console.log(
      `  >> Staked ${toDecimal({
        d: [lpTokenBalance.balance]
      })} LP to ${TARGET_ASSET}-UST LP`
    );

    console.log('Done');
  }
  async rewardsToClaim() {
    const poolInfo = await this.mirror.staking.getPoolInfo(this.assetTokenAddr);
    const rewardInfoResponse = await this.mirror.staking.getRewardInfo(
      this.wallet.key.accAddress,
      this.assetTokenAddr
    );
    const hasRewards =
      poolInfo.reward_index !== rewardInfoResponse.reward_infos[0].index;
    if (!hasRewards) console.log('No Rewards to Claim this Interval');
    return hasRewards;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDecimal(ms: any) {
  if (ms.d.length === 1) {
    return ms.d[0] / 1000000;
  } else {
    return ms.d[0] * 10 + ms.d[1] / 1000000;
  }
}
