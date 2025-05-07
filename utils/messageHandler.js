const venom = require('venom-bot');
const axios = require('axios');
const { MongoClient } = require('mongodb');
require('dotenv').config();
const geolib = require('geolib');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'daalMail';
const COLLECTION_NAME = 'orders';
const USERS_COLLECTION = 'users';

let cachedDb = null;
const connectToDatabase = async () => {
  if (cachedDb) return cachedDb;
  const client = await MongoClient.connect(MONGODB_URI);
  cachedDb = client.db(DB_NAME);
  return cachedDb;
};

const imageUrl = 'https://i.ibb.co/wnNL4s5/food-sample.jpg';
const menu = [
  { id: 1, name: 'Dal', price: 50, imageUrl },
  { id: 2, name: 'Chole', price: 60, imageUrl },
  { id: 3, name: 'Rajma', price: 55, imageUrl },
  { id: 4, name: 'Kadi', price: 45, imageUrl },
  { id: 5, name: 'Rice', price: 30, imageUrl },
  { id: 6, name: 'Bread', price: 20, imageUrl },
];

const defaultLocation = { latitude: 12.833365, longitude: 77.690315 };
function getItemIdFromName(itemName) {
  const item = menu.find(i => i.name.toLowerCase() === itemName.toLowerCase());
  return item ? item.id : null;
}

venom
  .create({ session: 'cloud-kitchen-session', multidevice: true, headless: false })
  .then(client => start(client))
  .catch(error => console.log('Error initializing bot:', error));

function start(client) {
  const userState = {};
  setInterval(() => checkForNewOrders(client), 5000);

  client.onMessage(async (message) => {
    const { body, from, type, lat, lng } = message;
    const db = await connectToDatabase();
    const usersCollection = db.collection(USERS_COLLECTION);

    let user = userState[from] || { started: false, isOrdering: false, isTracking: false, currentOrder: [], expectingNextStep: null, menuShown: false, previousAddresses: [] };
    userState[from] = user;

    let existingUser = await usersCollection.findOne({ waNumber: from });

    if (existingUser && existingUser.previousAddresses) {
      user.previousAddresses = existingUser.previousAddresses;
    }

    if (user.expectingNextStep === 'newAddress') {
      const newAddress = body;
      await usersCollection.updateOne(
        { waNumber: from },
        { $push: { previousAddresses: newAddress }, $set: { address: newAddress } }
      );
      await client.sendText(from, '✅ New address saved!\n\nHere’s our menu: https://sweet-sopapillas-fb37b3.netlify.app/?waNumber=' + from.split('@')[0]);
      user.expectingNextStep = null;
      user.menuShown = true;
      return;
    }

    if (user.expectingNextStep === 'newLocation') {
      if (type === 'location') {
        const location = { latitude: lat, longitude: lng };
        await usersCollection.updateOne(
          { waNumber: from },
          { $set: { location } }
        );
        await client.sendText(from, '📍 Location saved! Now please type your address 🏠');
        user.expectingNextStep = 'newAddress';
      } else {
        await client.sendText(from, 'Please share your location by tapping 📎 → Location → Send.');
      }
      return;
    }

    if (!existingUser || !existingUser.location) {
      if (type === 'location') {
        const location = { latitude: lat, longitude: lng };
        await usersCollection.updateOne(
          { waNumber: from },
          { $set: { waNumber: from, location, previousAddresses: [] } },
        );
        await client.sendText(from, 'Thanks! Now, please type your delivery address 🏠');
        user.expectingNextStep = 'address';
        return;
      } else {
        await client.sendText(from, 'Hi there! Please share your location first 📍\n\nTap the clip 📎 icon → Location → Send.');
        return;
      }
    }

    if (user.expectingNextStep === 'address') {
      user.deliveryAddress = body;
      user.expectingNextStep = null;

      await usersCollection.updateOne(
        { waNumber: from },
        { $push: { previousAddresses: body }, $set: { address: body } }
      );

      await client.sendText(from, 'Thanks for the address! 🙏\n\nHere’s our menu: https://sweet-sopapillas-fb37b3.netlify.app/?waNumber=' + from.split('@')[0]);
      user.menuShown = true;
      return;
    }

    if (!user.started) {
      user.started = true;
      await client.sendText(from, '👋 Welcome to Daal Mail!\n\nPlease choose an option:\n1. Place an order\n2. Track an order');
      return;
    }

    if (user.expectingNextStep === 'selectPreviousAddress') {
      const addressNumber = parseInt(body);
      if (!isNaN(addressNumber) && addressNumber > 0 && addressNumber <= user.previousAddresses.length) {
        const selectedAddress = user.previousAddresses[addressNumber - 1];
        await usersCollection.updateOne(
          { waNumber: from },
          { $set: { address: selectedAddress } }
        );
        await client.sendText(from, `✅ Using address:\n"${selectedAddress}"\n\nHere’s our menu: https://sweet-sopapillas-fb37b3.netlify.app/?waNumber=` + from.split('@')[0]);
        user.expectingNextStep = null;
        user.menuShown = true;
        return;
      } else if (!isNaN(addressNumber) && addressNumber === user.previousAddresses.length + 1) {
        await client.sendText(from, '📍 Please share your new location first.');
        user.expectingNextStep = 'newLocation';
        return;
      } else {
        await client.sendText(from, `Please enter a valid number from 1 to ${user.previousAddresses.length + 1}.`);
        return;
      }
    }

    if (body.toLowerCase().includes('hi') || body.toLowerCase().includes('hello')) {
      userState[from] = {
        started: false,
        isOrdering: false,
        isTracking: false,
        currentOrder: [],
        expectingNextStep: null,
        menuShown: false,
        previousAddresses: [],
      };
      user = userState[from];
      await client.sendText(
        from,
        '👋 Welcome to Daal Mail!\n\nPlease choose an option:\n1. Place an order\n2. Track an order',
      );
      return;
    }

    if (user.expectingNextStep &&
      body.toLowerCase() !== 'hi' &&
      body.toLowerCase() !== 'hello' &&
      !(user.expectingNextStep === 'selectingItems' && (body.match(/^[\d,]+$/) || body.split(',').every(item => getItemIdFromName(item.trim()) !== null))) &&
      !(user.expectingNextStep === 'addMore' && (body === '1' || body === '2')) &&
      !(user.expectingNextStep === 'selectPreviousAddress' && (!isNaN(parseInt(body)) && parseInt(body) > 0 && parseInt(body) <= user.previousAddresses.length + 1)) &&
      user.expectingNextStep !== 'trackingOrder' &&
      user.expectingNextStep !== 'newAddress' &&
      user.expectingNextStep !== 'newLocation' &&
      user.expectingNextStep !== 'address' &&
      user.expectingNextStep !== 'addressOption'
    ) {
      userState[from] = { started: false, isOrdering: false, isTracking: false, currentOrder: [], expectingNextStep: null, menuShown: false, previousAddresses: [] };
      user = userState[from];
      await client.sendText(from, 'I am not able to understand you. Please say Hi or Hello to start again.');
      return;
    }

    if (!user.started && !body.toLowerCase().includes('hi') && !body.toLowerCase().includes('hello')) {
      userState[from] = { started: false, isOrdering: false, isTracking: false, currentOrder: [], expectingNextStep: null, menuShown: false, previousAddresses: [] };
      user = userState[from];
      await client.sendText(from, 'I am not able to understand you. Please say Hi or Hello to start again.');
      return;
    }

    if (body === '1' && !user.isOrdering && !user.isTracking) {
      user.isOrdering = true;
      if (existingUser && existingUser.previousAddresses && existingUser.previousAddresses.length > 0) {
        let addressOptions = '📍 Your previous addresses:\n';
        existingUser.previousAddresses.forEach((address, index) => {
          addressOptions += `${index + 1}. ${address}\n`;
        });
        addressOptions += `\n${existingUser.previousAddresses.length + 1}. Add new address Or if you want to select existing address type the address option`;
        await client.sendText(from, addressOptions);
        user.expectingNextStep = 'selectPreviousAddress';
        return;
      } else {
        await client.sendText(from, '📍 Please share your location first.\n\nTap the clip 📎 icon → Location → Send.');
        user.expectingNextStep = 'newLocation';
        return;
      }
    }

    if (body === '2' && !user.isOrdering && !user.isTracking) {
      user.isTracking = true;
      user.expectingNextStep = 'trackingOrder';
      await client.sendText(from, 'Please enter the order ID to track your order.');
      return;
    }

    if (user.isOrdering && !user.menuShown) {
      await client.sendText(
        from,
        'Please check out our menu: https://sweet-sopapillas-fb37b3.netlify.app/?waNumber=' + from.split('@')[0],
      );
      user.menuShown = true;
      return;
    }

    if (user.isTracking) {
      const orderId = body.trim();
      const db = await connectToDatabase();
      const ordersCollection = db.collection(COLLECTION_NAME);
      const order = await ordersCollection.findOne({ orderId });
      if (order) {
        await client.sendText(
          from,
          `Tracking Order - ID: ${order.orderId}\nStatus: ${order.status}\nDelivery Address: ${order.address}\nItems: ${order.items.join(', ')}`,
        );
      } else {
        await client.sendText(from, 'No order found with this ID.');
      }
      user.isTracking = false;
      return;
    }
  });
