# AutoStaker

AutoStaker for MirrorProtocol

## How to use
1. Create .env file with following contents

   ```
   MNEMONIC=""
   TARGET_ASSET="MIR"
   ```  
   * MNEMONIC is your wallet seed phrase
   * TARGET is your desired autostake asset, one of ['MIR', 'mTSLA', 'mETH', etc...]

   > You can leave `MNEMONIC=""` and then run the program using `npm start -- --mnemonic="your mnemonic"`
   
   Or, you can use .env_example to create .env
   ```
   $ mv ./.env_example ./.env
   # update the contents
   $ nano ./.env
   ```

2. Install dependencies
   ```
   $ npm install
   ```

3. Start
   ```
   $ npm start
   ```
