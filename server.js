const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const { getHttpEndpoint, getHttpV4Endpoint } = require('@orbs-network/ton-access');
const { TonClient, Address, beginCell, toNano, TonClient4 } = require('@ton/ton');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { JettonRoot } = require('@dedust/sdk')

const app = express();
const upload = multer({ dest: 'uploads/' });
const port = 3001;

app.use(express.json());
app.use(express.static('public'));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});

app.use(limiter);

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || 'EQBIhPuWmjT7fP-VomuTWseE8JNWv2q7QYfsVQ1IZwnMk8wL';

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/upload', upload.single('csv'), (req, res) => {
    const results = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => {
            const address = data.address || data.recipient;
            if (address) {
                results.push({ address });
            }
        })
        .on('end', () => {
            res.json(results);
            fs.unlinkSync(req.file.path);
        });
});

app.post('/prepare-send', async (req, res) => {
    const { addresses, amount, tokenAddress, tokenDecimals, walletAddress } = req.body;
    
    if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
        return res.status(400).json({ error: 'Invalid or empty addresses array' });
    }
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
    }
    if (!tokenDecimals || isNaN(parseInt(tokenDecimals, 10))) {
        return res.status(400).json({ error: 'Invalid or missing token decimals' });
    }
    try {
        const preparedTx = await prepareBulkSend(walletAddress, addresses, amount, tokenAddress, parseInt(tokenDecimals, 10));
        res.json(preparedTx);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function prepareBulkSend(walletAddress, addresses, amount, tokenAddress, tokenDecimals) {
    if (tokenAddress) {
        return prepareTokenTransaction(walletAddress, addresses, amount, tokenAddress, tokenDecimals);
    } else {
        return prepareTONTransaction(addresses, amount);
    }
}

function prepareTONTransaction(addresses, amount) {
    const messages = [];

    for (let i = 0; i < addresses.length;) {
        const messagesTree = [];
        for (let cnt = 0; cnt < 4; cnt ++, i ++) {
            if (i >= addresses.length)
                break;
            messagesTree.push({
                address: addresses[i],
                amount: amount * 10 ** 9,
            });
        }
        messages.push(messagesTree);
    }

    return {
        messages: messages,
        validUntil: Math.floor(Date.now() / 1000) + 600, // Transaction is valid for 10 minutes
    };
}

async function prepareTokenTransaction(walletAddress, addresses, amount, tokenAddress, tokenDecimals) {
    const client = new TonClient({
        endpoint: await getHttpEndpoint({
          network: "mainnet",
        }),
      });  
    const messages = [];
    const amountWithDecimals = Math.floor(parseFloat(amount) * (10 ** tokenDecimals));

    for (let i = 0; i < addresses.length;) {
        const messagesTree = [];
        for (let cnt = 0; cnt < 4; cnt ++, i ++) {
            if (i >= addresses.length)
                break;
            const JETTON = Address.parse(tokenAddress)
            const scaleRoot = client.open(JettonRoot.createFromAddress(JETTON));
            // Get the sender's jetton wallet address
            const jettonWalletAddress = await getJettonWalletAddress(client, walletAddress, tokenAddress);

            const tokenWallet = client.open(await scaleRoot.getWallet(Address.parse(walletAddress)));

            const forwardPayload = beginCell()
            .storeUint(0, 32) // 0 opcode means we have a comment
            .storeStringTail('JettonTransfer')
            .endCell();

            const body = beginCell()
            .storeUint(0xf8a7ea5, 32) // opcode for jetton transfer
            .storeUint(0, 64) // query id
            .storeCoins(amountWithDecimals) // jetton amount, amount * 10^9
            .storeAddress(Address.parse(addresses[i])) // TON wallet destination address
            .storeAddress(Address.parse(walletAddress)) // response excess destination
            .storeBit(0) // no custom payload
            .storeCoins(toNano(0.1).toString()) // forward amount (if >0, will send notification message)
            .storeBit(1) // we store forwardPayload as a reference
            .storeRef(forwardPayload)
            .endCell();

            messagesTree.push({
                address: jettonWalletAddress,
                amount: toNano(0.5).toString(), // Execution fee, adjust as needed
                payload: body.toBoc().toString('base64'),
            });
        }
        messages.push(messagesTree);
    }

    return {
        messages: messages,
        validUntil: Math.floor(Date.now() / 1000) + 600, // Transaction is valid for 10 minutes
    };
}

async function getJettonWalletAddress(client, ownerAddress, jettonMasterAddress) {
    const result = await client.runMethod(
      Address.parse(jettonMasterAddress),
      "get_wallet_address",
      [{
        type: "slice",
        cell: beginCell()
          .storeAddress(Address.parse(ownerAddress))
          .endCell(),
      }]
    );
    return result.stack.readAddress().toString();
  }
  

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});