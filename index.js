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
const ORDERS_COLLECTION = 'orders';
const NETLIFY_MENU_LINK = 'https://sweet-sopapillas-fb37b3.netlify.app/';

let cachedDb = null;
const connectToDatabase = async () => {
  if (cachedDb) {
    console.log("connectToDatabase: Returning cached database connection");
    return cachedDb;
  }
  try {
    console.log("connectToDatabase: Connecting to MongoDB...");
    const client = await MongoClient.connect(MONGODB_URI);
    cachedDb = client.db(DB_NAME);
    console.log('connectToDatabase: Successfully connected to MongoDB');
    return cachedDb;
  } catch (error) {
    console.error('connectToDatabase: Error connecting to MongoDB:', error);
    throw error;
  }
};

async function getUserStateFromDb(db, waNumber) {
    const usersCollection = db.collection(USERS_COLLECTION);
    const user = await usersCollection.findOne({ waNumber: waNumber });
    return (user && user.state) ? user.state : { stage: 'start', addresses: [] };
}

async function saveUserStateToDb(db, waNumber, state) {
    const usersCollection = db.collection(USERS_COLLECTION);
    await usersCollection.updateOne(
        { waNumber: waNumber },
        { $set: { state: state, lastUpdated: new Date() } },
        { upsert: true }
    );
}

async function sendMessage(to, message, isInteractive = false, buttons = []) {
  try {
    console.log(`sendMessage: called with to: ${to}, message: ${message}, isInteractive: ${isInteractive}`);
    
    const messagePayload = isInteractive ? {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: message
        },
        action: {
          buttons: buttons.map((btn, index) => ({
            type: 'reply',
            reply: {
              id: `btn_${index}_${btn.id || index}`,
              title: btn.title
            }
          }))
        }
      }
    } : {
      messaging_product: 'whatsapp',
      to,
      text: { body: message },
    };

    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      messagePayload,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('sendMessage: successful');
  } catch (err) {
    console.error('sendMessage: Error sending message:', err.response?.data || err.message);
    throw err;
  }
}

async function sendListMessage(to, headerText, bodyText, buttonText, sections) {
  try {
    const messagePayload = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: {
          type: 'text',
          text: headerText
        },
        body: {
          text: bodyText
        },
        action: {
          button: buttonText,
          sections
        }
      }
    };

    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      messagePayload,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('sendListMessage: successful');
  } catch (err) {
    console.error('sendListMessage: Error sending message:', err.response?.data || err.message);
    throw err;
  }
}

// Session validation middleware for Netlify orders
async function validateOrderSession(req, res, next) {
  try {
    const { waNumber, botNumber } = req.body;
    
    if (!waNumber || !botNumber) {
      return res.status(400).json({ 
        error: 'WhatsApp number and bot number are required. Please go back to WhatsApp and try again.' 
      });
    }

    const db = await connectToDatabase();
    const user = await db.collection(USERS_COLLECTION).findOne({ waNumber });
    
    if (!user) {
      return res.status(400).json({ 
        error: 'User not found. Please start through WhatsApp bot flow.' 
      });
    }

    if (!user.state || user.state.stage !== 'done') {
      return res.status(403).json({ 
        error: 'Session expired or incomplete. Please restart through WhatsApp by sending "hi".' 
      });
    }

    if (botNumber !== PHONE_NUMBER_ID) {
      return res.status(403).json({ 
        error: 'Invalid bot number. Please use the correct WhatsApp bot.' 
      });
    }

    // Optional: 1 hour session expiry
    if (user.lastUpdated && (Date.now() - user.lastUpdated.getTime() > 3600000)) {
      return res.status(403).json({ 
        error: 'Session expired. Please restart through WhatsApp by sending "hi".' 
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Session validation error:', error);
    res.status(500).json({ error: 'Session validation failed' });
  }
}

app.get('/webhook', (req, res) => {
  console.log("GET /webhook: Received webhook verification request");
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('GET /webhook: Webhook verification successful');
    res.status(200).send(challenge);
  } else {
    console.log('GET /webhook: Webhook verification failed');
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  console.log("POST /webhook: Received webhook event");
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];
  const location = message?.location;
  const buttonResponse = message?.interactive?.button_reply;
  const listResponse = message?.interactive?.list_reply;

  if (!message && !buttonResponse && !listResponse) {
    console.log("POST /webhook: No message or interactive response found");
    return res.sendStatus(200);
  }

  const from = message?.from || buttonResponse?.from || listResponse?.from;
  const msgBody = message?.text?.body?.trim().toLowerCase() || '';
  const buttonId = buttonResponse?.id;
  const buttonTitle = buttonResponse?.title?.toLowerCase() || '';
  const listId = listResponse?.id;
  const listTitle = listResponse?.title?.toLowerCase() || '';
  
  console.log(`POST /webhook: from: ${from}, msgBody: ${msgBody}, buttonId: ${buttonId}, buttonTitle: ${buttonTitle}, listId: ${listId}, listTitle: ${listTitle}`);
  
  const db = await connectToDatabase();
  let state = await getUserStateFromDb(db, from);

  if (!state || typeof state !== 'object') {
    console.warn(`POST /webhook: Resetting state for ${from}`);
    state = { stage: 'start', addresses: [] };
  }

  // Handle interactive responses
  if (buttonResponse || listResponse) {
    const responseId = buttonId || listId;
    const responseTitle = buttonTitle || listTitle;
    
    if (state.stage === 'menu') {
      if (responseTitle.includes('place an order') || responseId.includes('place_order')) {
        await handlePlaceOrder(from, state, db.collection(USERS_COLLECTION));
        await saveUserStateToDb(db, from, state); 
        return res.sendStatus(200);
      } else if (responseTitle.includes('track your order') || responseId.includes('track_order')) {
        await handleTrackOrder(from, state, db.collection(ORDERS_COLLECTION));
        await saveUserStateToDb(db, from, state); 
        return res.sendStatus(200);
      }
    }
    
    if (state.stage === 'choose_address') {
      if (responseId.includes('address_')) {
        const index = parseInt(responseId.split('_')[1]);
        if (!isNaN(index) && state.addresses && index >= 0 && index < state.addresses.length) {
          const selectedAddress = state.addresses[index].address;
          state.stage = 'done'; 
          await sendMessage(from, `✅ Using your address: ${selectedAddress}`);
          await sendMessage(from, `${NETLIFY_MENU_LINK}?waNumber=${from}&botNumber=${PHONE_NUMBER_ID}`);
          await saveUserStateToDb(db, from, state); 
          return res.sendStatus(200);
        }
      } else if (responseId.includes('new_address')) {
        state.stage = 'collect_location';
        await sendMessage(from, '📍 Please share your location:');
        await saveUserStateToDb(db, from, state); 
        return res.sendStatus(200);
      }
    }
    
    if (state.stage === 'track_order' && responseId.includes('order_')) {
      const index = parseInt(responseId.split('_')[1]);
      if (!isNaN(index) && state.orders && index >= 0 && index < state.orders.length) {
        const selectedOrder = state.orders[index];
        await sendMessage(from, `📦 Order Status: ${selectedOrder.status}\nOrder Number: ${selectedOrder.orderNumber}`);
        state.stage = 'start';
        await saveUserStateToDb(db, from, state);
        await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
        return res.sendStatus(200);
      }
    }
  }

  // Handle text messages
  if (msgBody === 'hello' || msgBody === 'hi') { 
    if (state.stage === 'start') {
      state.stage = 'collect_location';
      await sendMessage(from, "👋 Welcome to Daal Mail!\n\nPlease share your location to continue with your order.");
    } else {
      state.stage = 'menu';
      await sendMessage(
        from, 
        '👋 Welcome back to Daal Mail!\n\nPlease choose an option:', 
        true, 
        [
          { title: 'Place an order', id: 'place_order' },
          { title: 'Track your order', id: 'track_order' }
        ]
      );
    }
    await saveUserStateToDb(db, from, state); 
    return res.sendStatus(200);
  } else if (state.stage === 'start') {
    await sendMessage(from, "Please send 'hi' or 'hello' to start.");
    return res.sendStatus(200);
  }

  if (state.stage === 'collect_location') {
    if (location) {
      state.userLocation = location;
      state.stage = 'collect_address';
      await sendMessage(from, "📍 Thank you for sharing your location. Now, please enter your address:");
    } else {
      await sendMessage(from, "❌ Location is required. Please share your location to proceed.");
    }
    await saveUserStateToDb(db, from, state); 
    return res.sendStatus(200);
  }

  if ((msgBody === '1' || msgBody.includes('place')) && state.stage === 'menu') {
    await handlePlaceOrder(from, state, db.collection(USERS_COLLECTION));
    await saveUserStateToDb(db, from, state); 
    return res.sendStatus(200);
  } else if ((msgBody === '2' || msgBody.includes('track')) && state.stage === 'menu') {
    await handleTrackOrder(from, state, db.collection(ORDERS_COLLECTION));
    await saveUserStateToDb(db, from, state); 
    return res.sendStatus(200);
  } else if (state.stage === 'menu') {
    await sendMessage(from, "Invalid option. Please choose 'Place an order' or 'Track your order'.");
    return res.sendStatus(200);
  }

  if (state.stage === 'collect_address') {
    const address = msgBody;
    if (state.userLocation) {
      const newEntry = { address, location: state.userLocation, timestamp: new Date() };
      state.addresses.push(newEntry);
      state.stage = 'done';
      
      await db.collection(USERS_COLLECTION).updateOne(
          { waNumber: from },
          { 
              $set: { 
                  'state': state,
                  lastUpdated: new Date() 
              },
              $push: { previousAddresses: newEntry }
          },
          { upsert: true }
      );

      await sendMessage(from, `✅ Address saved: ${address}`);
      await sendMessage(from, `${NETLIFY_MENU_LINK}?waNumber=${from}&botNumber=${PHONE_NUMBER_ID}`);
      return res.sendStatus(200);
    } else {
      await sendMessage(from, "❌ Location is required. Please share your location and address again.");
      state.stage = 'collect_location';
      await saveUserStateToDb(db, from, state); 
      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

// Helper functions
async function handlePlaceOrder(from, state, usersCollection) {
  const existingUser = await usersCollection.findOne({ waNumber: from });
  let currentAddresses = existingUser?.state?.addresses || [];
  if (currentAddresses.length === 0 && existingUser?.previousAddresses) {
      currentAddresses = existingUser.previousAddresses;
  }
  
  if (!Array.isArray(currentAddresses) || currentAddresses.length === 0) {
    state.stage = 'collect_location';
    await sendMessage(from, '📍 No previous address found. Please share your location to continue with your order:');
    return;
  }

  state.stage = 'choose_address';
  state.addresses = currentAddresses;

  if (currentAddresses.length <= 2) {
    const buttons = currentAddresses.map((item, index) => ({
      title: `${item.address.substring(0,20)}...`,
      id: `address_${index}`
    }));
    buttons.push({ title: '➕ Add new address', id: 'new_address' });
    await sendMessage(from, "📍 Please select an address or add a new one:", true, buttons);
  } else {
    let sections = [{
        title: "Your Saved Addresses",
        rows: currentAddresses.map((item, index) => ({
            id: `address_${index}`,
            title: item.address.substring(0, 24),
            description: `Address ${index + 1}`
        }))
    }];
    sections.push({
        title: "Other Options",
        rows: [{
            id: 'new_address',
            title: '➕ Add new address',
            description: 'Provide a new location and address'
        }]
    });

    await sendListMessage(from, "📍 Please select an address:", "Choose from your saved addresses or add a new one.", "Select Address", sections);
  }
}

async function handleTrackOrder(from, state, ordersCollection) {
  state.stage = 'track_order';
  const waNumberForQuery = from.startsWith('+') ? from : `+${from}`;
  const userOrders = await ordersCollection.find({ waNumber: waNumberForQuery }).sort({ orderTime: -1 }).limit(5).toArray();

  if (userOrders.length > 0) {
    if (userOrders.length <= 3) {
      const buttons = userOrders.map((order, index) => ({
        title: `Order ${index + 1} (${order.orderNumber})`,
        id: `order_${index}`
      }));
      await sendMessage(
        from,
        "📦 Your Previous Orders:\n" + 
        userOrders.map((o,i) => `${i+1}. Order ${o.orderNumber}`).join('\n') +
        "\nPlease select an order to track:",
        true,
        buttons
      );
    } else {
      let sections = [{
        title: "Your Previous Orders",
        rows: userOrders.map((order, index) => ({
          id: `order_${index}`,
          title: `Order ${index + 1} (${order.orderNumber})`,
          description: `Status: ${order.status}`
        }))
      }];
      await sendListMessage(from, "📦 Track Your Order", "Select an order from the list below to see its status.", "Track Order", sections);
    }
    state.orders = userOrders;
  } else {
    await sendMessage(from, "❌ No previous orders found.");
    state.stage = 'start';
  }
}

// Updated create-order endpoint with session validation
app.post('/create-order', validateOrderSession, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { orderItems, total, waNumber } = req.body;
    
    // Get address from validated user session
    const deliveryAddress = req.user.state.addresses?.length > 0 
      ? req.user.state.addresses[req.user.state.addresses.length - 1].address
      : "Not specified";

    const newOrder = {
      waNumber,
      orderItems,
      total,
      deliveryAddress, 
      status: 'Pending', 
      orderTime: new Date(),
      orderNumber: `DM${Math.floor(Math.random() * 1000000)}`,
    };

    await db.collection(ORDERS_COLLECTION).insertOne(newOrder);
    
    // Update user state
    await saveUserStateToDb(db, waNumber, { 
      stage: 'done', 
      addresses: req.user.state.addresses || [] 
    });

    res.status(201).json({
      message: 'Order created successfully',
      order: newOrder,
    });

    await sendMessage(waNumber, `Your order has been placed!\nOrder Number: ${newOrder.orderNumber}`);
    
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));