// index.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const MONGODB_URI = process.env.MONGODB_URI;

const DB_NAME = 'daalMail';
const USERS_COLLECTION = 'users';
const COLLECTION_NAME = 'orders';

let cachedDb = null;
const connectToDatabase = async () => {
  if (cachedDb) return cachedDb;
  const client = await MongoClient.connect(MONGODB_URI);
  cachedDb = client.db(DB_NAME);
  return cachedDb;
};

const userState = {};
const defaultLocation = { latitude: 12.833365, longitude: 77.690315 };
const imageUrl = 'https://i.ibb.co/wnNL4s5/food-sample.jpg';
const menu = [
  { id: 1, name: 'Dal', price: 50, imageUrl },
  { id: 2, name: 'Chole', price: 60, imageUrl },
  { id: 3, name: 'Rajma', price: 55, imageUrl },
  { id: 4, name: 'Kadi', price: 45, imageUrl },
  { id: 5, name: 'Rice', price: 30, imageUrl },
  { id: 6, name: 'Bread', price: 20, imageUrl },
];

async function sendMessage(to, message) {
  await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    text: { body: message },
  }, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];

  if (!message) return res.sendStatus(200);

  const from = message.from;
  const msgBody = message.text?.body || '';

  const db = await connectToDatabase();
  const usersCollection = db.collection(USERS_COLLECTION);

  let user = userState[from] || { started: false, isOrdering: false, isTracking: false, currentOrder: [], expectingNextStep: null, menuShown: false, previousAddresses: [] };
  userState[from] = user;

  const existingUser = await usersCollection.findOne({ waNumber: from });
  if (existingUser?.previousAddresses) user.previousAddresses = existingUser.previousAddresses;

  // Step 1: Greeting and Main Menu
  if (!user.started) {
    user.started = true;
    await sendMessage(from, '👋 Welcome to Daal Mail!\n\nPlease choose an option:\n1. Place an order\n2. Track an order');
    return res.sendStatus(200);
  }

  // Step 2: Order Flow
  if (user.isOrdering) {
    if (user.currentOrder.length === 0) {
      if (user.previousAddresses.length > 0) {
        let addressMsg = '📍 Choose your address:\n';
        user.previousAddresses.forEach((addr, i) => {
          addressMsg += `${i + 1}. ${addr}\n`;
        });
        addressMsg += `${user.previousAddresses.length + 1}. Enter a new address`;
        user.expectingNextStep = 'selectAddress';
        await sendMessage(from, addressMsg);
      } else {
        await sendMessage(from, '📍 Please enter your delivery address:');
        user.expectingNextStep = 'newAddress';
      }
      return res.sendStatus(200);
    }

    if (user.currentOrder.length > 0 && user.selectedAddress) {
      const orderId = `DM${Date.now()}`;
      const orderSummary = user.currentOrder.map(i => `${i.name} - ₹${i.price}`).join('\n');
      const total = user.currentOrder.reduce((sum, i) => sum + i.price, 0);

      await db.collection(COLLECTION_NAME).insertOne({
        orderId,
        waNumber: from,
        items: user.currentOrder,
        address: user.selectedAddress,
        status: 'Preparing',
        createdAt: new Date(),
      });

      await sendMessage(from, `✅ Order placed!\n\n🧾 Order ID: ${orderId}\n${orderSummary}\n📍 Delivery to: ${user.selectedAddress}\n💰 Total: ₹${total}\n\nYou can track your order anytime by replying with "2".`);

      userState[from] = {
        started: true,
        isOrdering: false,
        isTracking: false,
        currentOrder: [],
        expectingNextStep: null,
        menuShown: false,
        previousAddresses: user.previousAddresses,
      };
      return res.sendStatus(200);
    }
  }

  // Step 3: Address Selection
  if (user.expectingNextStep === 'selectAddress') {
    const choice = parseInt(msgBody.trim());
    if (!isNaN(choice) && choice >= 1 && choice <= user.previousAddresses.length) {
      user.selectedAddress = user.previousAddresses[choice - 1];
      await sendMessage(from, '📍 Address selected! Now, please share your location:');
      user.expectingNextStep = 'getLocation';
    } else if (choice === user.previousAddresses.length + 1) {
      await sendMessage(from, '📍 Please enter your new delivery address:');
      user.expectingNextStep = 'newAddress';
    } else {
      await sendMessage(from, '⚠️ Invalid choice. Please reply with a valid number.');
    }
    return res.sendStatus(200);
  }

  // Step 4: New Address Input
  if (user.expectingNextStep === 'newAddress') {
    user.selectedAddress = msgBody.trim();
    if (!user.previousAddresses.includes(user.selectedAddress)) {
      user.previousAddresses.push(user.selectedAddress);
      await usersCollection.updateOne(
        { waNumber: from },
        { $set: { waNumber: from, previousAddresses: user.previousAddresses } },
        { upsert: true }
      );
    }
    await sendMessage(from, '📍 Address saved! Now, please share your location:');
    user.expectingNextStep = 'getLocation';
    return res.sendStatus(200);
  }

  // Step 5: Location Collection
  if (user.expectingNextStep === 'getLocation') {
    user.location = msgBody.trim();
    await sendMessage(from, '📋 Here\'s our menu:\n' + menu.map(item => `${item.id}. ${item.name} - ₹${item.price}`).join('\n') + '\n\nReply with item names (e.g., "Dal, Rice")');
    user.menuShown = true;
    user.expectingNextStep = null;
    return res.sendStatus(200);
  }

  // Step 6: Track Order Flow
  if (msgBody.trim() === '2') {
    user.isTracking = true;
    await sendMessage(from, '📍 Please enter your Order ID to track your order:');
    user.expectingNextStep = 'trackOrder';
    return res.sendStatus(200);
  }

  return res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook running on port ${PORT}`));