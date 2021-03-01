# AutoStaker

AutoStaker for MirrorProtocol

## How to use
1. Create .env file with following contents

   ```
   MNEMONIC=""
   MNEMONIC_INDEX=0
   COIN_TYPE=330
   ```  
   > You can leave `MNEMONIC=""` and then run the program using `npm start -- --mnemonic="your mnemonic"`
   
   Or, you can use .env_example to create .env
   ```
   $ mv ./.env_example ./.env
   # update the contetns
   $ nano ./.env
   ```

2. install dependency
   ```
   $ npm install
   ```

3. start 
   ```
   $ npm start
   ```
