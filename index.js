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

// --- NEW/MODIFIED: Functions to handle user state persistence ---
async function getUserStateFromDb(db, waNumber) {
    const usersCollection = db.collection(USERS_COLLECTION);
    const user = await usersCollection.findOne({ waNumber: waNumber });
    // Return the 'state' field if it exists, otherwise a default 'start' state
    return user ? user.state : { stage: 'start', addresses: [] };
}

async function saveUserStateToDb(db, waNumber, state) {
    const usersCollection = db.collection(USERS_COLLECTION);
    await usersCollection.updateOne(
        { waNumber: waNumber },
        { $set: { state: state, lastUpdated: new Date() } }, // Store the state object
        { upsert: true } // Create the document if it doesn't exist
    );
}
// --- END NEW/MODIFIED ---


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

// REMOVED: const userState = {}; - No longer needed as state is in DB

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

  // --- NEW: Load user state from DB ---
  let state = await getUserStateFromDb(db, from);
  console.log(`POST /webhook: User state for ${from}:`, state);
  // --- END NEW ---

  // Handle interactive responses first
  if (buttonResponse || listResponse) {
    const responseId = buttonId || listId;
    const responseTitle = buttonTitle || listTitle;
    
    console.log(`Interactive response: ${responseTitle} (${responseId}) from ${from}`);
    
    if (state.stage === 'menu') {
      if (responseTitle.includes('place an order') || responseId.includes('place_order')) {
        await handlePlaceOrder(from, state, usersCollection);
        await saveUserStateToDb(db, from, state); // Save state after handling
        return res.sendStatus(200);
      } else if (responseTitle.includes('track your order') || responseId.includes('track_order')) {
        await handleTrackOrder(from, state, ordersCollection);
        await saveUserStateToDb(db, from, state); // Save state after handling
        return res.sendStatus(200);
      }
    }
    
    if (state.stage === 'choose_address') {
      if (responseId.includes('address_')) {
        const index = parseInt(responseId.split('_')[1]);
        if (!isNaN(index) && state.addresses && index >= 0 && index < state.addresses.length) {
          const selectedAddress = state.addresses[index].address;
          state.stage = 'done'; // Set stage to done or to menu directly
          console.log(`Selected address: ${selectedAddress} for ${from}`);
          await sendMessage(from, `✅ Using your address: ${selectedAddress}`);
          await sendMessage(from, `${NETLIFY_MENU_LINK}?waNumber=${from}`);
          await saveUserStateToDb(db, from, state); // Save state after address selection
          return res.sendStatus(200);
        }
      } else if (responseId.includes('new_address')) {
        state.stage = 'collect_location';
        await sendMessage(from, '📍 Please share your location:');
        await saveUserStateToDb(db, from, state); // Save state after changing stage
        return res.sendStatus(200);
      }
    }
    
    if (state.stage === 'track_order' && responseId.includes('order_')) {
      const index = parseInt(responseId.split('_')[1]);
      if (!isNaN(index) && state.orders && index >= 0 && index < state.orders.length) {
        const selectedOrder = state.orders[index];
        await sendMessage(from, `📦 Order Status: ${selectedOrder.status}\nOrder Number: ${selectedOrder.orderNumber}\nOrder Time: ${selectedOrder.orderTime}`);
        state.stage = 'done';
        // delete userState[from]; // No longer delete from in-memory, just reset stage
        await saveUserStateToDb(db, from, { stage: 'start', addresses: [] }); // Reset user state in DB
        await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
        return res.sendStatus(200);
      }
    }
  }

  // Handle text messages (fallback)
  if (msgBody === 'hello' || msgBody === 'hi' || state.stage === 'start') {
    const existingUser = await usersCollection.findOne({ waNumber: from });
    if (!existingUser || !existingUser.state || existingUser.state.stage === 'start') { // Also check for existing state
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
    await saveUserStateToDb(db, from, state); // Save state after handling hi/hello
    return res.sendStatus(200);
  } else if (state.stage === 'start') {
    await sendMessage(from, "Please send 'hi' or 'hello' to start.");
    // No state change, so no save needed here unless you want to persist the 'start' state explicitly for new users
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
    await saveUserStateToDb(db, from, state); // Save state after handling location
    return res.sendStatus(200);
  }

  if (msgBody === '1' && state.stage === 'menu') {
    await handlePlaceOrder(from, state, usersCollection);
    await saveUserStateToDb(db, from, state); // Save state after handling place order
    return res.sendStatus(200);
  } else if (msgBody === '2' && state.stage === 'menu') {
    await handleTrackOrder(from, state, ordersCollection);
    await saveUserStateToDb(db, from, state); // Save state after handling track order
    return res.sendStatus(200);
  } else if (state.stage === 'menu') {
    await sendMessage(from, "Invalid option. Please choose 1 or 2.");
    return res.sendStatus(200);
  }

  if (state.stage === 'track_order' && state.orders) {
    const orderNumberChoice = parseInt(msgBody);
    if (!isNaN(orderNumberChoice) && orderNumberChoice > 0 && orderNumberChoice <= state.orders.length) {
      const selectedOrder = state.orders[orderNumberChoice - 1];
      await sendMessage(from, `📦 Order Status: ${selectedOrder.status}\nOrder Number: ${selectedOrder.orderNumber}\nOrder Time: ${selectedOrder.orderTime}`);
      state.stage = 'done';
      // delete userState[from]; // No longer delete from in-memory
      await saveUserStateToDb(db, from, { stage: 'start', addresses: [] }); // Reset user state in DB
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
      state.stage = 'done'; // Set to done or menu, depending on desired next step
      console.log(`Selected address: ${selectedAddress} for ${from}`);
      await sendMessage(from, `✅ Using your address: ${selectedAddress}`);
      await sendMessage(from, `${NETLIFY_MENU_LINK}?waNumber=${from}`);
      await saveUserStateToDb(db, from, state); // Save state after address selection
    } else if (choice === state.addresses.length + 1) {
      state.stage = 'collect_location';
      await sendMessage(from, '📍 Please share your location:');
      await saveUserStateToDb(db, from, state); // Save state after changing stage
    } else {
      await sendMessage(from, '❌ Invalid option. Please reply with a valid number from the list above.');
    }
    return res.sendStatus(200);
  }

  if (state.stage === 'collect_address') {
    const address = msgBody;
    if (state.userLocation) {
      const existingUserDoc = await usersCollection.findOne({ waNumber: from }); // Fetch full user document
      const newEntry = { address, location: state.userLocation, timestamp: new Date() };
      
      // Update the user's previousAddresses within the existing document
      if (existingUserDoc) {
        await usersCollection.updateOne(
          { waNumber: from },
          { 
              $set: { 
                  'state.userLocation': state.userLocation, // Update location in state
                  'state.addresses': [...(existingUserDoc.state.addresses || []), newEntry], // Add new address to state.addresses
                  'state.stage': 'done', // Update stage
                  lastUpdated: new Date() 
              },
              $push: { previousAddresses: newEntry } // Also push to previousAddresses array at top level if desired
          }
        );
        // Ensure state object reflects the update for immediate use
        state.addresses = [...(existingUserDoc.state.addresses || []), newEntry];
        state.stage = 'done';

      } else {
        // This case should ideally be handled by initial 'hi'/'hello' flow, but as a fallback:
        const newUser = {
          waNumber: from,
          state: {
            stage: 'done',
            userLocation: state.userLocation,
            addresses: [newEntry]
          },
          previousAddresses: [newEntry], // Store also at top level
          lastUpdated: new Date()
        };
        await usersCollection.insertOne(newUser);
        state.addresses = [newEntry];
        state.stage = 'done';
      }

      console.log(`New address saved: ${address} for ${from}`);
      await sendMessage(from, `✅ Address saved: ${address}`);
      await sendMessage(from, `${NETLIFY_MENU_LINK}?waNumber=${from}`);
      await saveUserStateToDb(db, from, state); // Save final state after address collection
      return res.sendStatus(200);
    } else {
      await sendMessage(from, "❌ Location is required. Please share your location and address again.");
      state.stage = 'collect_location';
      await saveUserStateToDb(db, from, state); // Save state after prompting for location again
      return res.sendStatus(200);
    }
  }

  if (state.stage === 'done') {
    console.log(`Conversation completed for ${from}, sending menu link.`);
    // A user in 'done' stage is usually ready to order, so send menu link directly.
    await sendMessage(from, `${NETLIFY_MENU_LINK}?waNumber=${from}`);
    // No need to reset stage to 'start' here, they can directly use the link.
    // If you want them to restart bot flow, change state.stage = 'start';
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// Helper function for handling place order flow - FIXED to handle WhatsApp button limit
async function handlePlaceOrder(from, state, usersCollection) {
  const existingUser = await usersCollection.findOne({ waNumber: from });
  
  // Ensure state.addresses and previousAddresses are populated correctly from DB.
  // We'll prioritize the state.addresses from the database if available, otherwise fallback.
  let currentAddresses = existingUser?.state?.addresses || existingUser?.previousAddresses || [];
  
  if (!Array.isArray(currentAddresses) || currentAddresses.length === 0) {
    state.stage = 'collect_location';
    await sendMessage(from, '📍 No previous address found. Please share your location to continue with your order:');
    return;
  }

  state.stage = 'choose_address';
  state.addresses = currentAddresses; // Use the fetched addresses

  if (currentAddresses.length <= 2) {
    let msg = '📍 We found your previous addresses:\n\n';
    currentAddresses.forEach((item, index) => {
      msg += `${index + 1}. ${item.address}\n`;
    });
    
    const buttons = currentAddresses.map((item, index) => ({
      title: `Address ${index + 1}`,
      id: `address_${index}`
    }));
    
    buttons.push({ title: '➕ Add new address', id: 'new_address' });
    
    await sendMessage(from, msg, true, buttons);
  } else {
    let msg = '📍 We found your previous addresses:\n\n';
    currentAddresses.forEach((item, index) => {
      msg += `${index + 1}. ${item.address}\n`;
    });
    msg += `\n${currentAddresses.length + 1}. Add new address`;
    
    await sendMessage(from, msg, false);
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
        title: `Order ${index + 1}`,
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
      // Use text list for more than 3 orders
      let orderListMessage = "📦 Your Previous Orders:\n";
      userOrders.forEach((order, index) => {
        orderListMessage += `${index + 1}. Order Number: ${order.orderNumber}\n`;
      });
      orderListMessage += "\nPlease reply with the number of the order you want to track:";
      await sendMessage(from, orderListMessage);
    }
    state.orders = userOrders; // Store fetched orders in state for later lookup
  } else {
    await sendMessage(from, "❌ No previous orders found.");
    state.stage = 'done'; // Set stage to done as there are no orders to track
  }
}

// Order creation endpoint (from your HTML, likely your /create-order or /processOrder)
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

    // You might want to get the latest confirmed address from user.state.addresses
    // or from previousAddresses array if you decided to store selected address there
    let deliveryAddress = "Not specified"; // Default
    if (user.state && user.state.addresses && user.state.addresses.length > 0) {
      deliveryAddress = user.state.addresses[user.state.addresses.length - 1].address; // Use the last added/confirmed address
    } else if (user.previousAddresses && user.previousAddresses.length > 0) {
      deliveryAddress = user.previousAddresses[user.previousAddresses.length - 1].address;
    }


    const newOrder = {
      waNumber,
      orderItems,
      total,
      deliveryAddress, // Include delivery address
      status: 'Pending', // Initial status
      orderTime: new Date(),
      orderNumber: `DM${Math.floor(Math.random() * 1000000)}`,
    };

    const result = await ordersCollection.insertOne(newOrder);
    console.log("POST /create-order: Order saved to database:", result);

    // Optionally update user state to 'done' or 'menu' after order is placed
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