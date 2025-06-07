import { createClient } from '@supabase/supabase-js';
import { Bot, InlineKeyboard } from 'grammy';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Create bot instance
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Function to format phone number
function formatPhoneNumber(phone) {
  const cleaned = phone.replace(/\D/g, '');
  
  if (cleaned.length === 10 && cleaned.startsWith('0')) {
    return `+251${cleaned.substring(1)}`;
  }
  
  if (cleaned.length === 9 && !cleaned.startsWith('0')) {
    return `+251${cleaned}`;
  }
  
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

// Store user sessions and pending deposits
const userSessions = new Map();
const pendingDeposits = new Map();

// Create main menu keyboard
function createMainMenuKeyboard() {
  return new InlineKeyboard()
    .text("💰 Balance", "balance")
    .text("💳 Deposit", "deposit").row()
    .text("💸 Withdraw", "withdraw")
    .text("🎮 Play", "play").row()
    .text("📝 Transactions", "transactions")
    .text("🚪 Logout", "logout");
}

// Start command
bot.command("start", (ctx) => {
  const welcomeMessage = `👋 Welcome to the Payment Bot!

Use /login to get started or choose from the options below:`;

  const keyboard = new InlineKeyboard()
    .text("🔐 Login", "show_login_help")
    .text("ℹ️ Help", "help");

  return ctx.reply(welcomeMessage, { reply_markup: keyboard });
});

// Help command
bot.command("help", (ctx) => {
  const helpMessage = `ℹ️ Available commands:

/login [phone] [password] - Log in to your account
Example: /login 0961401822 yourpassword

Once logged in, use the buttons to:
• Check your balance
• Make deposits with image proof
• Request withdrawals
• View transaction history
• Play games
• Logout`;

  return ctx.reply(helpMessage);
});

// Login command
bot.command("login", async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  
  if (args.length < 2) {
    return ctx.reply("Please provide your phone and password like this:\n/login 0961401822 yourpassword");
  }
  
  const [phoneInput, password] = args;
  const phone = formatPhoneNumber(phoneInput);
  
  try {
    // Sign in with phone and password
    const { data, error } = await supabase.auth.signInWithPassword({
      phone: phone,
      password: password
    });

    if (error) throw error;

    // Get user data from users table
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("phone", phone)
      .single();

    if (userError) throw userError;

    // Store user session
    userSessions.set(ctx.from.id, {
      userId: userData.id,
      phone: phone,
      username: userData.username,
      balance: userData.balance,
      authToken: data.session.access_token
    });

    const welcomeMessage = `✅ Successfully logged in as ${userData.username}!
💰 Current Balance: ${userData.balance.toFixed(2)} ETB

Choose an option:`;

    return ctx.reply(welcomeMessage, { reply_markup: createMainMenuKeyboard() });
  } catch (err) {
    console.error("Login error:", err);
    return ctx.reply("❌ Login failed. Please check your phone and password.");
  }
});

// Callback query handlers
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userSession = userSessions.get(ctx.from.id);

  // Handle login help
  if (data === "show_login_help") {
    await ctx.answerCallbackQuery();
    return ctx.reply("To login, use this format:\n/login [your_phone] [your_password]\n\nExample:\n/login 0961401822 mypassword");
  }

  // Handle help
  if (data === "help") {
    await ctx.answerCallbackQuery();
    const helpMessage = `ℹ️ Available features:

🔐 Login with your phone and password
💰 Check your current balance
💳 Make deposits with image proof
💸 Request withdrawals
🎮 Play games
📝 View transaction history
🚪 Logout when done

Use /login [phone] [password] to get started!`;
    return ctx.reply(helpMessage);
  }

  // Check if user is logged in for other actions
  if (!userSession && data !== "show_login_help" && data !== "help") {
    await ctx.answerCallbackQuery("Please log in first!");
    return ctx.reply("❌ Please log in first using /login [phone] [password]");
  }

  switch (data) {
    case "balance":
      await handleBalance(ctx, userSession);
      break;
    case "deposit":
      await handleDepositStart(ctx, userSession);
      break;
    case "withdraw":
      await handleWithdrawStart(ctx, userSession);
      break;
    case "play":
      await handlePlay(ctx);
      break;
    case "transactions":
      await handleTransactions(ctx, userSession);
      break;
    case "logout":
      await handleLogout(ctx);
      break;
    case "back_to_menu":
      await showMainMenu(ctx, userSession);
      break;
  }

  await ctx.answerCallbackQuery();
});

// Balance handler
async function handleBalance(ctx, userSession) {
  try {
    // Get updated balance
    const { data: userData, error } = await supabase
      .from("users")
      .select("balance")
      .eq("phone", userSession.phone)
      .single();
    
    if (error) throw error;
    
    // Update session balance
    userSession.balance = userData.balance;
    userSessions.set(ctx.from.id, userSession);
    
    const keyboard = new InlineKeyboard().text("🔙 Back to Menu", "back_to_menu");
    
    return ctx.editMessageText(
      `💰 Your current balance: ${userData.balance.toFixed(2)} ETB`,
      { reply_markup: keyboard }
    );
  } catch (err) {
    console.error("Balance check error:", err);
    return ctx.reply("❌ Failed to check balance. Please try again.");
  }
}

// Deposit start handler
async function handleDepositStart(ctx, userSession) {
  const keyboard = new InlineKeyboard().text("🔙 Back to Menu", "back_to_menu");
  
  await ctx.editMessageText(
    "💳 Deposit Money\n\nPlease enter the amount you want to deposit (minimum 10 ETB):",
    { reply_markup: keyboard }
  );
  
  // Set user state to waiting for deposit amount
  pendingDeposits.set(ctx.from.id, { step: "waiting_amount", userSession });
}

// Withdraw start handler
async function handleWithdrawStart(ctx, userSession) {
  const keyboard = new InlineKeyboard().text("🔙 Back to Menu", "back_to_menu");
  
  await ctx.editMessageText(
    `💸 Withdraw Money\n\nCurrent Balance: ${userSession.balance.toFixed(2)} ETB\n\nPlease enter the amount and account number like this:\n50 100023456789\n\n(Minimum withdrawal: 50 ETB)`,
    { reply_markup: keyboard }
  );
  
  // Set user state to waiting for withdrawal info
  pendingDeposits.set(ctx.from.id, { step: "waiting_withdrawal", userSession });
}

// Play handler
async function handlePlay(ctx) {
  const keyboard = new InlineKeyboard()
    .url("🎮 Play Habesha Games", "https://t.me/habesha_games_bot/habesha")
    .text("🔙 Back to Menu", "back_to_menu");
  
  await ctx.editMessageText(
    "🎮 Ready to Play?\n\nClick the button below to start playing Habesha Games!",
    { reply_markup: keyboard }
  );
}

// Transactions handler
async function handleTransactions(ctx, userSession) {
  try {
    // Get last 5 transactions
    const { data: transactions, error } = await supabase
      .from("player_transactions")
      .select("*")
      .eq("player_phone", userSession.phone)
      .order("created_at", { ascending: false })
      .limit(5);
    
    if (error) throw error;
    
    const keyboard = new InlineKeyboard().text("🔙 Back to Menu", "back_to_menu");
    
    if (!transactions || transactions.length === 0) {
      return ctx.editMessageText(
        "📝 You have no transactions yet.",
        { reply_markup: keyboard }
      );
    }
    
    let message = "📝 Your recent transactions:\n\n";
    
    transactions.forEach(tx => {
      const date = new Date(tx.created_at).toLocaleString();
      const type = tx.transaction_type.charAt(0).toUpperCase() + tx.transaction_type.slice(1);
      const amount = tx.amount >= 0 ? `+${tx.amount.toFixed(2)}` : tx.amount.toFixed(2);
      const status = tx.status === 'pending' ? '⏳' : (tx.status === 'rejected' ? '❌' : '✅');
      
      message += `${status} ${date} - ${type}: ${amount} ETB\n`;
      message += `💬 ${tx.description || 'No description'}\n\n`;
    });
    
    return ctx.editMessageText(message, { reply_markup: keyboard });
  } catch (err) {
    console.error("Transactions error:", err);
    return ctx.reply("❌ Failed to fetch transactions. Please try again.");
  }
}

// Logout handler
async function handleLogout(ctx) {
  if (userSessions.has(ctx.from.id)) {
    userSessions.delete(ctx.from.id);
    pendingDeposits.delete(ctx.from.id);
    
    const keyboard = new InlineKeyboard()
      .text("🔐 Login Again", "show_login_help")
      .text("ℹ️ Help", "help");
    
    return ctx.editMessageText(
      "✅ Successfully logged out.\n\nThank you for using Payment Bot!",
      { reply_markup: keyboard }
    );
  }
  return ctx.reply("❌ You're not currently logged in.");
}

// Show main menu
async function showMainMenu(ctx, userSession) {
  const welcomeMessage = `👋 Welcome back, ${userSession.username}!
💰 Current Balance: ${userSession.balance.toFixed(2)} ETB

Choose an option:`;

  return ctx.editMessageText(welcomeMessage, { reply_markup: createMainMenuKeyboard() });
}

// Handle text messages for deposit and withdrawal flows
bot.on("message:text", async (ctx) => {
  const userId = ctx.from.id;
  const pendingDeposit = pendingDeposits.get(userId);
  
  if (!pendingDeposit) return;
  
  const { step, userSession } = pendingDeposit;
  
  if (step === "waiting_amount") {
    const amount = parseFloat(ctx.message.text);
    
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply("❌ Please enter a valid amount (numbers only)");
    }
    
    if (amount < 10) {
      return ctx.reply("❌ Minimum deposit amount is 10 ETB");
    }
    
    // Update pending deposit with amount
    pendingDeposits.set(userId, { 
      step: "waiting_image", 
      userSession, 
      amount 
    });
    
    const keyboard = new InlineKeyboard().text("🔙 Back to Menu", "back_to_menu");
    
    return ctx.reply(
      `💳 Deposit Amount: ${amount.toFixed(2)} ETB\n\nNow please send a screenshot or photo of your payment confirmation as proof.`,
      { reply_markup: keyboard }
    );
  }
  
  if (step === "waiting_withdrawal") {
    const parts = ctx.message.text.trim().split(' ');
    
    if (parts.length < 2) {
      return ctx.reply("❌ Please provide both amount and account number like this:\n50 100023456789");
    }
    
    const amount = parseFloat(parts[0]);
    const accountNumber = parts[1];
    
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply("❌ Please enter a valid amount");
    }
    
    if (amount > userSession.balance) {
      return ctx.reply("❌ Insufficient balance for this withdrawal");
    }
    
    if (amount < 50) {
      return ctx.reply("❌ Minimum withdrawal amount is 50 ETB");
    }
    
    try {
      // Check current balance
      const { data: userData, error: userError } = await supabase
        .from("users")
        .select("balance")
        .eq("phone", userSession.phone)
        .single();
        
      if (userError) throw userError;
      
      if (amount > userData.balance) {
        return ctx.reply("❌ Insufficient balance");
      }
      
      const newBalance = userData.balance - amount;
      
      // Update user balance
      const { error: updateError } = await supabase
        .from("users")
        .update({ balance: newBalance })
        .eq("phone", userSession.phone);
        
      if (updateError) throw updateError;
      
      // Create transaction record
      const { error: transactionError } = await supabase
        .from("player_transactions")
        .insert({
          player_phone: userSession.phone,
          transaction_type: "withdrawal",
          amount: -amount,
          balance_before: userData.balance,
          balance_after: newBalance,
          description: `Withdrawal to account ${accountNumber}`,
          status: "pending",
          game_id: null,
          created_at: new Date().toISOString()
        });
        
      if (transactionError) throw transactionError;
      
      // Update session balance
      userSession.balance = newBalance;
      userSessions.set(userId, userSession);
      
      // Clear pending state
      pendingDeposits.delete(userId);
      
      const keyboard = new InlineKeyboard().text("🔙 Back to Menu", "back_to_menu");
      
      return ctx.reply(
        `✅ Withdrawal request of ${amount.toFixed(2)} ETB to account ${accountNumber} submitted!\n\nIt will be processed within 24 hours.`,
        { reply_markup: keyboard }
      );
    } catch (err) {
      console.error("Withdrawal error:", err);
      return ctx.reply("❌ Failed to process withdrawal. Please try again.");
    }
  }
});

// Handle photo messages for deposit proof
bot.on("message:photo", async (ctx) => {
  const userId = ctx.from.id;
  const pendingDeposit = pendingDeposits.get(userId);
  
  if (!pendingDeposit || pendingDeposit.step !== "waiting_image") {
    return ctx.reply("❌ Please start a deposit request first using the Deposit button.");
  }
  
  const { userSession, amount } = pendingDeposit;
  
  try {
    // Get the largest photo size
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileId = photo.file_id;
    
    // Create a pending transaction with image proof
    const { error } = await supabase
      .from("player_transactions")
      .insert({
        player_phone: userSession.phone,
        transaction_type: "deposit",
        amount: amount,
        balance_before: userSession.balance,
        balance_after: userSession.balance,
        description: `Deposit with image proof (File ID: ${fileId})`,
        status: "pending",
        game_id: null,
        created_at: new Date().toISOString()
      });

    if (error) throw error;
    
    // Clear pending state
    pendingDeposits.delete(userId);
    
    const keyboard = new InlineKeyboard().text("🔙 Back to Menu", "back_to_menu");
    
    return ctx.reply(
      `✅ Deposit request of ${amount.toFixed(2)} ETB submitted with image proof!\n\nYour request will be reviewed and processed shortly.`,
      { reply_markup: keyboard }
    );
  } catch (err) {
    console.error("Deposit error:", err);
    return ctx.reply("❌ Failed to process deposit. Please try again.");
  }
});

// Error handling
bot.catch((err) => {
  console.error("Bot error:", err);
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

// Start the bot
bot.start();
console.log("🤖 Enhanced Telegram Payment Bot started successfully!");
console.log("Bot is now running with interactive buttons and image proof functionality...");