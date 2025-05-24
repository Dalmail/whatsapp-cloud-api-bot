const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // Your bot's WhatsApp Phone Number ID
const MONGODB_URI = process.env.MONGODB_URI;

const DB_NAME = 'daalMail';
const USERS_COLLECTION = 'users';
const ORDERS_COLLECTION = 'orders';
const NETLIFY_MENU_LINK = 'https://sweet-sopapillas-fb37b3.netlify.app/'; // Ensure this is your actual Netlify deployed menu link

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

// --- MODIFIED: Functions to handle user state persistence ---
async function getUserStateFromDb(db, waNumber) {
    const usersCollection = db.collection(USERS_COLLECTION);
    const user = await usersCollection.findOne({ waNumber: waNumber });
    // Ensure that if user is not found, or user.state is null/undefined, we return a valid initial state object
    return (user && user.state) ? user.state : { stage: 'start', addresses: [] };
}

async function saveUserStateToDb(db, waNumber, state) {
    const usersCollection = db.collection(USERS_COLLECTION);
    await usersCollection.updateOne(
        { waNumber: waNumber },
        { $set: { state: state, lastUpdated: new Date() } }, // Store the state object
        { upsert: true } // Create the document if it doesn't exist
    );
}
// --- END MODIFIED ---


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
    throw err; // Propagate the error for handling
  }
}

async function sendListMessage(to, headerText, bodyText, buttonText, sections) {
  try {
    console.log(`sendListMessage: called with to: ${to}`);
    
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
    throw err; // Propagate the error
  }
}

app.get('/webhook', (req, res) => {
  console.log("GET /webhook: Received webhook verification request");
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  console.log(`GET /webhook: mode: ${mode}, token: ${token}, challenge: ${challenge}`);
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
    console.log("POST /webhook: No message or interactive response found in payload");
    return res.sendStatus(200);
  }

  const from = message?.from || buttonResponse?.from || listResponse?.from;
  const msgBody = message?.text?.body?.trim().toLowerCase() || '';
  const buttonId = buttonResponse?.id;
  const buttonTitle = buttonResponse?.title?.toLowerCase() || '';
  const listId = listResponse?.id;
  const listTitle = listResponse?.title?.toLowerCase() || '';
  
  console.log(`POST /webhook: from: ${from}, msgBody: ${msgBody}, buttonId: ${buttonId}, buttonTitle: ${buttonTitle}, listId: ${listId}, listTitle: ${listTitle}, location: ${JSON.stringify(location)}`);
  
  const db = await connectToDatabase();
  const usersCollection = db.collection(USERS_COLLECTION);
  const ordersCollection = db.collection(ORDERS_COLLECTION);

  let state = await getUserStateFromDb(db, from);

  // *** CRUCIAL FIX: Ensure state is always an object, even if getUserStateFromDb returns undefined/null ***
  if (!state || typeof state !== 'object') {
    console.warn(`POST /webhook: Initial state for ${from} was invalid or missing. Resetting to default.`);
    state = { stage: 'start', addresses: [] };
  }
  console.log(`POST /webhook: User state for ${from} (after check):`, state);

  // Handle interactive responses first
  if (buttonResponse || listResponse) {
    const responseId = buttonId || listId;
    const responseTitle = buttonTitle || listTitle;
    
    console.log(`Interactive response: ${responseTitle} (${responseId}) from ${from}`);
    
    if (state.stage === 'menu') {
      if (responseTitle.includes('place an order') || responseId.includes('place_order')) {
        await handlePlaceOrder(from, state, usersCollection);
        await saveUserStateToDb(db, from, state); 
        return res.sendStatus(200);
      } else if (responseTitle.includes('track your order') || responseId.includes('track_order')) {
        await handleTrackOrder(from, state, ordersCollection);
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
          console.log(`Selected address: ${selectedAddress} for ${from}`);
          await sendMessage(from, `✅ Using your address: ${selectedAddress}`);
          // MODIFIED: Pass botNumber to frontend
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
        await sendMessage(from, `📦 Order Status: ${selectedOrder.status}\nOrder Number: ${selectedOrder.orderNumber}\nOrder Time: ${selectedOrder.orderTime}`);
        state.stage = 'start'; // Reset to start after tracking
        await saveUserStateToDb(db, from, state); // Save reset state
        await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
        return res.sendStatus(200);
      }
    }
  }

  // Handle text messages
  if (msgBody === 'hello' || msgBody === 'hi') { 
    if (state.stage === 'start') { // If user is new or truly at start
      state.stage = 'collect_location';
      await sendMessage(from, "👋 Welcome to Daal Mail!\n\nPlease share your location to continue with your order.");
    } else { // Returning user, send to main menu
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
  } else if (state.stage === 'start') { // If not 'hi'/'hello' but still in 'start' state
    await sendMessage(from, "Please send 'hi' or 'hello' to start.");
    return res.sendStatus(200);
  }

  if (state.stage === 'collect_location') {
    if (location) {
      state.userLocation = location;
      state.stage = 'collect_address';
      await sendMessage(from, "📍 Thank you for sharing your location. Now, please enter your address:");
      console.log(`Location received: ${JSON.stringify(location)}`);
    } else {
      await sendMessage(from, "❌ Location is required. Please share your location to proceed.");
    }
    await saveUserStateToDb(db, from, state); 
    return res.sendStatus(200);
  }

  // Handle direct text inputs for menu/track (if not using interactive buttons)
  if ((msgBody === '1' || msgBody.includes('place')) && state.stage === 'menu') {
    await handlePlaceOrder(from, state, usersCollection);
    await saveUserStateToDb(db, from, state); 
    return res.sendStatus(200);
  } else if ((msgBody === '2' || msgBody.includes('track')) && state.stage === 'menu') {
    await handleTrackOrder(from, state, ordersCollection);
    await saveUserStateToDb(db, from, state); 
    return res.sendStatus(200);
  } else if (state.stage === 'menu') {
    // This else if is only needed if you expect text replies "1" or "2" for menu
    // With interactive buttons, this branch might not be hit often
    await sendMessage(from, "Invalid option. Please choose 'Place an order' or 'Track your order'.");
    return res.sendStatus(200);
  }

  if (state.stage === 'track_order' && state.orders) {
    const orderNumberChoice = parseInt(msgBody);
    if (!isNaN(orderNumberChoice) && orderNumberChoice > 0 && orderNumberChoice <= state.orders.length) {
      const selectedOrder = state.orders[orderNumberChoice - 1];
      await sendMessage(from, `📦 Order Status: ${selectedOrder.status}\nOrder Number: ${selectedOrder.orderNumber}\nOrder Time: ${selectedOrder.orderTime}`);
      state.stage = 'start'; // Reset to start after tracking
      await saveUserStateToDb(db, from, state); 
      await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
      return res.sendStatus(200);
    } else {
      await sendMessage(from, "❌ Invalid order number. Please enter a valid number from the list.");
      return res.sendStatus(200);
    }
  } else if (state.stage === 'track_order') {
    await sendMessage(from, "❌ Invalid input. Please enter a valid order number from the list.");
    return res.sendStatus(200);
  }

  if (state.stage === 'choose_address') {
    const choice = parseInt(msgBody);
    if (!isNaN(choice) && choice >= 1 && choice <= state.addresses.length) {
      const selectedAddress = state.addresses[choice - 1].address;
      state.stage = 'done'; 
      console.log(`Selected address: ${selectedAddress} for ${from}`);
      await sendMessage(from, `✅ Using your address: ${selectedAddress}`);
      // MODIFIED: Pass botNumber to frontend
      await sendMessage(from, `${NETLIFY_MENU_LINK}?waNumber=${from}&botNumber=${PHONE_NUMBER_ID}`);
      await saveUserStateToDb(db, from, state); 
    } else if (choice === state.addresses.length + 1) { // Assuming "Add new address" is always the last option + 1
      state.stage = 'collect_location';
      await sendMessage(from, '📍 Please share your location:');
      await saveUserStateToDb(db, from, state); 
    } else {
      await sendMessage(from, '❌ Invalid option. Please reply with a valid number from the list above.');
    }
    return res.sendStatus(200);
  }

  if (state.stage === 'collect_address') {
    const address = msgBody;
    if (state.userLocation) {
      const newEntry = { address, location: state.userLocation, timestamp: new Date() };
      
      // Update the user's state.addresses directly
      state.addresses.push(newEntry);
      state.stage = 'done'; // Transition to 'done' after collecting address
      
      // Also update the database. We need to fetch current previousAddresses to append
      const existingUserDoc = await usersCollection.findOne({ waNumber: from });
      let previousAddresses = existingUserDoc?.previousAddresses || [];
      previousAddresses.push(newEntry); // Add to previousAddresses array
      
      await usersCollection.updateOne(
          { waNumber: from },
          { 
              $set: { 
                  'state.userLocation': state.userLocation, // Update location in state
                  'state.addresses': state.addresses, // Set the updated addresses array in state
                  'state.stage': state.stage, // Set the updated stage
                  previousAddresses: previousAddresses, // Update the top-level previousAddresses
                  lastUpdated: new Date() 
              }
          },
          { upsert: true }
      );

      console.log(`New address saved: ${address} for ${from}`);
      await sendMessage(from, `✅ Address saved: ${address}`);
      // MODIFIED: Pass botNumber to frontend
      await sendMessage(from, `${NETLIFY_MENU_LINK}?waNumber=${from}&botNumber=${PHONE_NUMBER_ID}`);
      // No need to save state again, it's already updated and saved in the updateOne call above
      return res.sendStatus(200);
    } else {
      await sendMessage(from, "❌ Location is required. Please share your location and address again.");
      state.stage = 'collect_location';
      await saveUserStateToDb(db, from, state); 
      return res.sendStatus(200);
    }
  }

  if (state.stage === 'done') {
    console.log(`Conversation completed for ${from}, sending menu link.`);
    // MODIFIED: Pass botNumber to frontend
    await sendMessage(from, `${NETLIFY_MENU_LINK}?waNumber=${from}&botNumber=${PHONE_NUMBER_ID}`);
    // Keep stage as 'done' so they can directly use the link.
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// Helper function for handling place order flow - FIXED to handle WhatsApp button limit
async function handlePlaceOrder(from, state, usersCollection) {
  const existingUser = await usersCollection.findOne({ waNumber: from });
  
  // Ensure state.addresses and previousAddresses are populated correctly from DB.
  let currentAddresses = existingUser?.state?.addresses || []; // Prefer state.addresses
  if (currentAddresses.length === 0 && existingUser?.previousAddresses) {
      currentAddresses = existingUser.previousAddresses; // Fallback to previousAddresses if state.addresses is empty
  }
  
  if (!Array.isArray(currentAddresses) || currentAddresses.length === 0) {
    state.stage = 'collect_location';
    await sendMessage(from, '📍 No previous address found. Please share your location to continue with your order:');
    return;
  }

  state.stage = 'choose_address';
  state.addresses = currentAddresses; // Store fetched addresses in current state

  if (currentAddresses.length <= 2) { // WhatsApp allows up to 3 buttons
    let msg = '📍 We found your previous addresses:\n\n';
    const buttons = currentAddresses.map((item, index) => ({
      title: `${item.address.substring(0,20)}...`, // Truncate long addresses for button title
      id: `address_${index}`
    }));
    
    buttons.push({ title: '➕ Add new address', id: 'new_address' });
    
    await sendMessage(from, msg + "\nPlease select an address or add a new one:", true, buttons);
  } else {
    // Use list message for more than 3 addresses or simple text list
    let sections = [{
        title: "Your Saved Addresses",
        rows: currentAddresses.map((item, index) => ({
            id: `address_${index}`,
            title: item.address.substring(0, 24), // Truncate title
            description: `Address ${index + 1}` // Optional description
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

// Helper function for handling track order flow
async function handleTrackOrder(from, state, ordersCollection) {
  state.stage = 'track_order';
  const waNumberForQuery = from.startsWith('+') ? from : `+${from}`;
  console.log(`Tracking orders for waNumber: ${waNumberForQuery}`);
  const userOrders = await ordersCollection.find({ waNumber: waNumberForQuery }).sort({ orderTime: -1 }).limit(5).toArray(); // Fetch last 5 orders

  if (userOrders.length > 0) {
    if (userOrders.length <= 3) {
      // Use buttons for 3 or fewer orders
      const buttons = userOrders.map((order, index) => ({
        title: `Order ${index + 1} (${order.orderNumber})`,
        id: `order_${index}`
      }));
      
      let orderListMessage = "📦 Your Previous Orders:\n";
      userOrders.forEach((order, index) => {
        orderListMessage += `${index + 1}. Order Number: ${order.orderNumber}\n`;
      });
      
      await sendMessage(
        from,
        orderListMessage + "\nPlease select an order to track:",
        true,
        buttons
      );
    } else {
      // Use list message for more than 3 orders
      let sections = [{
        title: "Your Previous Orders",
        rows: userOrders.map((order, index) => ({
          id: `order_${index}`,
          title: `Order ${index + 1} (${order.orderNumber})`,
          description: `Total: ₹${order.total} | Status: ${order.status}`
        }))
      }];

      await sendListMessage(from, "📦 Track Your Order", "Select an order from the list below to see its status.", "Track Order", sections);
    }
    state.orders = userOrders; // Store fetched orders in state for later lookup
  } else {
    await sendMessage(from, "❌ No previous orders found.");
    state.stage = 'start'; // Reset stage to start as there are no orders to track
  }
}

// Order creation endpoint
app.post('/create-order', async (req, res) => {
  console.log("POST /create-order: Entered /create-order route");
  try {
    const db = await connectToDatabase();
    const ordersCollection = db.collection('orders');
    const usersCollection = db.collection('users');

    const { orderItems, total, waNumber } = req.body;
    console.log("POST /create-order: Received data:", { orderItems, total, waNumber });

    if (!waNumber) {
      console.log("POST /create-order: WhatsApp number is missing");
      return res.status(400).json({ error: 'WhatsApp number is required. Please provide it in the request body.' });
    }

    const user = await usersCollection.findOne({ waNumber });
    console.log("POST /create-order: User found:", user);
    if (!user) {
      console.log("POST /create-order: WhatsApp number not found in database");
      return res.status(400).json({ error: 'WhatsApp number not found. Please go back to WhatsApp and try again.' });
    }

    let deliveryAddress = "Not specified"; 
    // Prefer state.addresses if available, then previousAddresses
    if (user.state && user.state.addresses && user.state.addresses.length > 0) {
      deliveryAddress = user.state.addresses[user.state.addresses.length - 1].address; 
    } else if (user.previousAddresses && user.previousAddresses.length > 0) {
      deliveryAddress = user.previousAddresses[user.previousAddresses.length - 1].address;
    }


    const newOrder = {
      waNumber,
      orderItems,
      total,
      deliveryAddress, 
      status: 'Pending', 
      orderTime: new Date(),
      orderNumber: `DM${Math.floor(Math.random() * 1000000)}`,
    };

    const result = await ordersCollection.insertOne(newOrder);
    console.log("POST /create-order: Order saved to database:", result);

    // Optionally update user state to 'done' or 'menu' after order is placed
    // Keep user state in 'done' or 'menu' after order so they can continue using the menu
    await saveUserStateToDb(db, waNumber, { stage: 'done', addresses: user.state.addresses || [] });


    res.status(201).json({
      message: 'Order created successfully',
      order: newOrder,
    });

    const orderSummary = `
Order Summary:
Order Number: ${newOrder.orderNumber}
Total: ₹${total.toFixed(2)}
Delivery Address: ${deliveryAddress}
Items:
${orderItems.map(item => `- ${item.name} x ${item.quantity}`).join('\n')}
Status: ${newOrder.status}
    `;
    console.log("POST /create-order: Order summary: ", orderSummary);
    try {
      await sendMessage(waNumber, `Your order has been placed!\n${orderSummary}`);
      console.log("POST /create-order: sendMessage call successful");
    } catch (e) {
      console.error("POST /create-order: Error sending message from create-order", e.response?.data || e.message);
    }
  } catch (error) {
    console.error('POST /create-order: Error creating order:', error);
    res.status(500).json({ error: 'Failed to create order: ' + error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));