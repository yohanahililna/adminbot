const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');

// Error handling
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

const app = express();

// Configuration
const config = {
  supabaseUrl: 'https://hxqvvsnhcpkqdjhdnupx.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh4cXZ2c25oY3BrcWRqaGRudXB4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDkyMDMyNTgsImV4cCI6MjA2NDc3OTI1OH0.bMEezL5ee2c1zGSOCUHcSu9Jls_sF1Kjqx5IvvuhYN4',
  port: process.env.PORT || 3000,
  corsOrigin: process.env.CORS_ORIGIN || '*'
};

// Enhanced CORS configuration
const allowedOrigins = [
  config.corsOrigin,
  'http://localhost:3000',
  'https://cards-git-main-kb-solutions-projects.vercel.app'
];

// Middleware
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.static('public'));
app.use(bodyParser.json());

// Initialize Supabase
const supabase = createClient(config.supabaseUrl, config.supabaseKey);

// Create HTTP server
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Server running on port ${config.port}`);
}).on('error', (err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true
  }
});

// Wallet configuration
const WALLET_BASE_URL = 'https://bot-cjuh.onrender.com';
const WALLET_PASS_KEY = 'afdasfdsf78as87t3g4b3whf23847dasd';
// Update the GameWallet class to handle rollback transactions
class GameWallet {
  constructor(authToken = null) {
    this.authToken = authToken;
  }

  async processDebit(transactionData) {
    try {
      const response = await fetch(`${WALLET_BASE_URL}/api/operator/wallet/debit`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.authToken}`,
          'pass-key': WALLET_PASS_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(transactionData)
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        return {
          success: false,
          error: result.error || 'Debit failed',
          code: 'WALLET_DEBIT_FAILED'
        };
      }
      
      return {
        success: true,
        data: result
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        code: 'WALLET_CONNECTION_ERROR'
      };
    }
  }

  async processCredit(transactionData) {
    try {
      const endpoint = transactionData.transaction_type === 'rollback' 
        ? '/api/operator/wallet/credit/rollback'
        : '/api/operator/wallet/credit';

      const response = await fetch(`${WALLET_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.authToken}`,
          'pass-key': WALLET_PASS_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(transactionData)
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        return {
          success: false,
          error: result.error || 'Credit failed',
          code: 'WALLET_CREDIT_FAILED'
        };
      }
      
      return {
        success: true,
        data: result
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        code: 'WALLET_CONNECTION_ERROR'
      };
    }
  }
}

// Game state management
const activeGames = new Map();
const gameRooms = new Map();
const playerConnections = new Map();
const disconnectTimers = new Map();
const PROCESSING_TIMEOUTS = new Set();

// Helper functions
function generateDeck() {
  const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const deck = [];
  
  for (const suit of suits) {
    for (const value of values) {
      deck.push({
        suit,
        value,
        code: `${value}${suit.charAt(0).toUpperCase()}`
      });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cleanupGameResources(gameCode) {
  if (disconnectTimers.has(gameCode)) {
    clearTimeout(disconnectTimers.get(gameCode));
    disconnectTimers.delete(gameCode);
  }
  activeGames.delete(gameCode);
  gameRooms.delete(gameCode);
  playerConnections.delete(gameCode);
}

// Wallet Proxy Endpoints
app.post('/api/wallet/user', async (req, res) => {
  try {
    const { userId, token } = req.body;
    
    const response = await fetch(`${WALLET_BASE_URL}/api/operator/wallet/get/${userId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'pass-key': WALLET_PASS_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) throw new Error('Failed to fetch user data');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Wallet error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/wallet/transaction', async (req, res) => {
  try {
    const { userId, token, type, amount, transactionId, game } = req.body;
    
    const endpointMap = {
      'debit': '/api/operator/wallet/debit',
      'credit': '/api/operator/wallet/credit',
      'rollback': '/api/operator/wallet/credit/rollback'
    };

    const response = await fetch(`${WALLET_BASE_URL}${endpointMap[type]}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'pass-key': WALLET_PASS_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        transaction_id: transactionId,
        round_id: game,
        user_id: userId,
        username: 'cards_player',
        amount: amount,
        game: game,
        transaction_type: type,
        status: "pending"
      })
    });

    if (!response.ok) throw new Error(`Transaction failed: ${await response.text()}`);
    res.json(await response.json());
  } catch (error) {
    console.error('Transaction error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Game endpoints
app.get('/api/game/:code', async (req, res) => {
  try {
    const { data: game, error } = await supabase
      .from('cards_game')
      .select('*')
      .eq('code', req.params.code)
      .single();

    if (error || !game) return res.status(404).json({ error: 'Game not found' });
    res.json(game);
  } catch (error) {
    console.error('Game fetch error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

async function refundDeductedBets(gameCode) {
  const { data: game, error } = await supabase
    .from('cards_game')
    .select('*')
    .eq('code', gameCode)
    .single();

  if (error) throw error;

  if (game.player1_bet_deducted && game.player1_auth_token) {
    const wallet = new GameWallet(game.player1_auth_token);
    await wallet.processCredit({
      transaction_id: `REFUND_${game.player1_bet_transaction_id}`,
      round_id: `${gameCode}`,
      user_id: game.player1_phone,
      username: game.player1_username || 'cards_player1',
      amount: game.bet,
      game: 'crazy',
      transaction_type: 'credit',
      status: "completed",
      metadata: {
        original_transaction: game.player1_bet_transaction_id,
        reason: 'game_cancellation'
      }
    });
  }

  if (game.player2_bet_deducted && game.player2_auth_token) {
    const wallet = new GameWallet(game.player2_auth_token);
    await wallet.processCredit({
      transaction_id: `REFUND_${game.player2_bet_transaction_id}`,
      round_id: `${gameCode}`,
      user_id: game.player2_phone,
      username: game.player2_username || 'cards_player2',
      amount: game.bet,
      game: 'crazy',
      transaction_type: 'credit',
      status: "completed",
      metadata: {
        original_transaction: game.player2_bet_transaction_id,
        reason: 'game_cancellation'
      }
    });
  }

  await supabase
    .from('cards_game')
    .update({
      player1_bet_deducted: false,
      player2_bet_deducted: false,
      player1_bet_transaction_id: null,
      player2_bet_transaction_id: null,
      status: 'cancelled',
      updated_at: new Date().toISOString()
    })
    .eq('code', gameCode);
}

const TURN_TIME_LIMIT = 30000;

async function checkTurnTimeouts() {
  const now = new Date();
  
  for (const [gameCode, game] of activeGames) {
    if (PROCESSING_TIMEOUTS.has(gameCode)) continue;
    
    if (game.last_move_timestamp && game.status === 'ongoing') {
      const lastMove = new Date(game.last_move_timestamp);
      const elapsed = now - lastMove;
      const remaining = Math.max(0, TURN_TIME_LIMIT - elapsed);
      
      io.to(gameCode).emit('turnTimeUpdate', { 
        remainingTime: Math.floor(remaining / 1000),
        currentPlayer: game.current_player
      });
      
      if (remaining <= 0) {
        PROCESSING_TIMEOUTS.add(gameCode);
        
        const currentPlayer = game.current_player;
        const timeoutField = `player${currentPlayer}_timeouts`;
        const currentTimeouts = game[timeoutField] || 0;
        const newTimeouts = currentTimeouts + 1;

        try {
          const { data: updatedGame, error } = await supabase
            .from('cards_game')
            .update({
              [timeoutField]: newTimeouts,
              updated_at: new Date().toISOString()
            })
            .eq('code', gameCode)
            .select()
            .single();

          if (error) throw error;

          activeGames.set(gameCode, {
            ...game,
            [timeoutField]: newTimeouts,
            last_move_timestamp: new Date().toISOString()
          });

          if (newTimeouts >= 3) {
            const winner = currentPlayer === 1 ? 2 : 1;
            await endGame(gameCode, winner, 'timeout_forfeit');
            io.to(gameCode).emit('gameOver', {
              winner,
              reason: `Player ${currentPlayer} forfeited by timing out 3 times`,
              timeoutCount: newTimeouts,
              payout: game.bet ? game.bet * 1.8 : 0
            });
          } else {
            if (game.has_drawn) {
              const passResult = await passTurn(gameCode, currentPlayer);
              io.to(gameCode).emit('gameUpdate', {
                ...passResult,
                message: `Player ${currentPlayer} timed out (${newTimeouts}/3) - turn passed`,
                timeoutCount: newTimeouts
              });
            } else {
              const drawResult = await processDrawCard(gameCode, currentPlayer);
              const passResult = await passTurn(gameCode, currentPlayer);
              io.to(gameCode).emit('gameUpdate', {
                ...drawResult,
                ...passResult,
                message: `Player ${currentPlayer} timed out (${newTimeouts}/3) - forced to draw`,
                timeoutCount: newTimeouts
              });
            }
            
            checkGameEndConditions(gameCode, activeGames.get(gameCode));
          }
        } catch (error) {
          console.error('Error handling turn timeout:', error);
        } finally {
          PROCESSING_TIMEOUTS.delete(gameCode);
        }
      }
    }
  }
}

setInterval(checkTurnTimeouts, 1000);

// Socket.IO Connection Handling
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

// In the joinGame socket handler, modify the bet deduction section:
  socket.on('joinGame', async ({ gameCode, playerNumber }) => {
    try {
      // Initialize room if it doesn't exist
      if (!gameRooms.has(gameCode)) {
        gameRooms.set(gameCode, { player1: null, player2: null });
      }

      // Get the room object
      const room = gameRooms.get(gameCode);
      if (!room) {
        throw new Error('Failed to initialize game room');
      }

      // Join the socket room
      socket.join(gameCode);
      socket.gameCode = gameCode;
      socket.playerNumber = playerNumber;

      // Update room state
      room[`player${playerNumber}`] = socket.id;

      // Initialize player connections if needed
      if (!playerConnections.has(gameCode)) {
        playerConnections.set(gameCode, { player1: null, player2: null });
      }
      playerConnections.get(gameCode)[`player${playerNumber}`] = socket.id;

      // Get or create game state
      const game = await getOrCreateGame(gameCode);
      activeGames.set(gameCode, game);

      if (game.status === 'finished' || game.status === 'abandoned') {
        throw new Error('This game has already ended');
      }

      // Send game state to the joining player
      socket.emit('gameState', game);

      // Check if both players have joined
      if (room.player1 && room.player2) {
        const { data: currentGame, error: fetchError } = await supabase
          .from('cards_game')
          .select('*')
          .eq('code', gameCode)
          .single();

        if (fetchError) throw fetchError;

        try {
          // Process player 1 bet deduction
          if (currentGame.bet && currentGame.player1_auth_token && !currentGame.player1_bet_deducted) {
            const transactionId = `CARDS_${gameCode}_P1_BET_${Date.now()}`;
            const wallet = new GameWallet(currentGame.player1_auth_token);
            const debitResult = await wallet.processDebit({
              transaction_id: transactionId,
              round_id: `${gameCode}`,
              user_id: currentGame.player1_phone,
              username: currentGame.player1_username || 'cards_player1',
              amount: currentGame.bet,
              game: 'crazy',
              transaction_type: 'debit',
              status: "pending"
            });

            if (!debitResult.success) {
              throw new Error(`Failed to deduct bet from player 1: ${debitResult.error}`);
            }

            const { error: updateError } = await supabase
              .from('cards_game')
              .update({
                player1_bet_deducted: true,
                player1_bet_transaction_id: transactionId,
                updated_at: new Date().toISOString()
              })
              .eq('code', gameCode);

            if (updateError) throw updateError;

            io.to(room.player1).emit('balanceUpdate', {
              amount: -currentGame.bet,
              newBalance: debitResult.data.newBalance,
              message: `$${currentGame.bet} deducted for game bet`,
              transactionId
            });
          }

          // Process player 2 bet deduction
          if (currentGame.bet && currentGame.player2_auth_token && !currentGame.player2_bet_deducted) {
            const transactionId = `CARDS_${gameCode}_P2_BET_${Date.now()}`;
            const wallet = new GameWallet(currentGame.player2_auth_token);
            const debitResult = await wallet.processDebit({
              transaction_id: transactionId,
              round_id: `${gameCode}`,
              user_id: currentGame.player2_phone,
              username: currentGame.player2_username || 'cards_player2',
              amount: currentGame.bet,
              game: 'crazy',
              transaction_type: 'debit',
              status: "pending"
            });

            if (!debitResult.success) {
              // Rollback player 1's bet if player 2's deduction fails
              if (currentGame.player1_bet_deducted && currentGame.player1_auth_token) {
                const rollbackId = `ROLLBACK_${gameCode}_P1_${Date.now()}`;
                const wallet = new GameWallet(currentGame.player1_auth_token);
                await wallet.processCredit({
                  transaction_id: rollbackId,
                  round_id: `${gameCode}`,
                  user_id: currentGame.player1_phone,
                  username: currentGame.player1_username || 'cards_player1',
                  amount: currentGame.bet,
                  game: 'crazy',
                  transaction_type: 'rollback',
                  status: "completed",
                  metadata: {
                    original_transaction: currentGame.player1_bet_transaction_id,
                    reason: 'player2_deduction_failed'
                  }
                });

                await supabase
                  .from('cards_game')
                  .update({
                    player1_bet_deducted: false,
                    player1_bet_transaction_id: null,
                    updated_at: new Date().toISOString()
                  })
                  .eq('code', gameCode);
              }

              throw new Error(`Failed to deduct bet from player 2: ${debitResult.error}`);
            }

            const { error: updateError } = await supabase
              .from('cards_game')
              .update({
                player2_bet_deducted: true,
                player2_bet_transaction_id: transactionId,
                updated_at: new Date().toISOString()
              })
              .eq('code', gameCode);

            if (updateError) throw updateError;

            io.to(room.player2).emit('balanceUpdate', {
              amount: -currentGame.bet,
              newBalance: debitResult.data.newBalance,
              message: `$${currentGame.bet} deducted for game bet`,
              transactionId
            });
          }

          // Mark game as ongoing if both deductions succeeded
          await supabase
            .from('cards_game')
            .update({
              status: 'ongoing',
              updated_at: new Date().toISOString(),
              last_move_timestamp: new Date().toISOString()
            })
            .eq('code', gameCode);

          io.to(gameCode).emit('gameStart', { 
            message: 'Game started! Player 1 goes first.',
            currentPlayer: 1,
            betDeducted: true
          });
if (game.discard_pile.length < 2) {
  // Mark game as ongoing if both deductions succeeded
  const updateResult = await supabase
    .from('cards_game')
    .update({
      status: 'ongoing',
      updated_at: new Date().toISOString(),
      last_move_timestamp: new Date().toISOString() // Start the timer
    })
    .eq('code', gameCode)
    .select()
    .single();

  if (updateResult.error) throw updateResult.error;
  
  const updatedGame = updateResult.data;
  activeGames.set(gameCode, updatedGame);

  io.to(gameCode).emit('gameStart', { 
    message: 'Game started! Player 1 goes first.',
    currentPlayer: 1,
    betDeducted: true,
    turnTimeLimit: TURN_TIME_LIMIT,
    turnStartTime: new Date().toISOString()
  });

  // Immediately check for timeouts to start the countdown
  checkTurnTimeouts();}
        } catch (deductionError) {
          console.error('Bet deduction error:', deductionError);
          cleanupGameResources(gameCode);
          
          io.to(gameCode).emit('gameError', {
            message: 'Failed to deduct bets. Game cancelled.',
            error: deductionError.message,
            refundsIssued: deductionError.message.includes('player 2')
          });
          return;
        }
      }
    } catch (error) {
      console.error('Join game error:', error);
      socket.emit('error', {
        message: 'Failed to join game',
        error: error.message
      });
    }
  });

  socket.on('checkBetStatus', async ({ gameCode }, callback) => {
    try {
      const { data, error } = await supabase
        .from('games')
        .select('player1_bet_deducted, player2_bet_deducted')
        .eq('game_code', gameCode)
        .single();
      
      if (error) throw error;
      
      callback({
        player1_bet_deducted: data.player1_bet_deducted,
        player2_bet_deducted: data.player2_bet_deducted
      });
    } catch (err) {
      callback({ error: 'Failed to check bet status' });
    }
  });
  
  socket.on('getGameState', ({ gameCode }) => {
    checkBetsAndSendState(gameCode, socket);
  });

  socket.on('playCard', async ({ gameCode, card, playerNumber, options }) => {
    try {
      const game = activeGames.get(gameCode);
      if (!game) throw new Error('Game not found');
      if (game.current_player !== playerNumber) throw new Error("It's not your turn");

      const result = await processCardPlay(gameCode, card, playerNumber, options || {});
      
      if (result.specialEffect === 'draw_cards') {
        let message = '';
        
        if (card.value === 'A' && card.suit === 'spades') {
          if (result.drawCards === 7) {
            message = `🔥 Player ${playerNumber} countered the Ace of Spades with a 2 of Spades! Player ${result.opponentNumber} must draw 7 cards!`;
          } else {
            message = `💀 Player ${playerNumber} played the DEADLY Ace of Spades! Player ${result.opponentNumber} must draw 5 cards!`;
          }
        } 
        else if (card.value === '2' && card.suit === 'spades' && result.drawCards === 7) {
          message = `🔥 Player ${playerNumber} countered the Ace of Spades with a 2 of Spades! Player ${result.opponentNumber} must draw 7 cards!`;
        }
        else if (card.value === '2') {
          message = `⚠️ Player ${playerNumber} played a 2! Player ${result.opponentNumber} must draw ${result.drawCards} cards`;
        }
        else {
          message = `Player ${playerNumber} played a ${card.value}`;
        }

        io.to(gameCode).emit('gameUpdate', {
          ...result,
          message: message,
          isSpecialCard: (card.value === 'A' && card.suit === 'spades') || 
                        (card.value === '2' && card.suit === 'spades' && result.drawCards === 7)
        });
      } 
      else if (result.specialEffect === 'change_suit') {
        io.to(gameCode).emit('gameUpdate', {
          ...result,
          message: `🎨 Player ${playerNumber} changed the suit to ${options.newSuit}`
        });
      } 
      else if (result.specialEffect === 'skip') {
        io.to(gameCode).emit('gameUpdate', {
          ...result,
          message: `⏭️ Player ${playerNumber} played a ${card.value} and gets another turn!`
        });
      } 
      else if (result.specialEffect === 'multi_discard') {
        io.to(gameCode).emit('gameUpdate', {
          ...result,
          message: `♠️ Player ${playerNumber} discarded multiple ${card.suit} cards`
        });
      } 
      else {
        io.to(gameCode).emit('gameUpdate', {
          ...result,
          message: `Player ${playerNumber} played a ${card.value} of ${card.suit}`
        });
      }

      checkGameEndConditions(gameCode, result.gameState);
    } catch (error) {
      console.error('Play card error:', error);
      socket.emit('error', {
        message: error.message,
        isRecoverable: error.message.includes('must match suit') || 
                      error.message.includes('not your turn')
      });
      
      if (!error.message.includes('must match suit') && 
          !error.message.includes('not your turn')) {
        io.to(gameCode).emit('error', {
          message: error.message,
          isRecoverable: false
        });
      }
    }
  });

  socket.on('chooseCardOptions', async ({ gameCode, playerNumber, card, options }) => {
    try {
      const game = activeGames.get(gameCode);
      if (!game) throw new Error('Game not found');
      if (game.current_player !== playerNumber) throw new Error("It's not your turn");

      if (card.value === '7') {
        socket.emit('promptSevenOption', {
          gameCode,
          card,
          possibleCards: game[`player${playerNumber}_cards`].filter(c => c.suit === card.suit && c.value !== '7')
        });
      } 
      else if (['8', 'J'].includes(card.value)) {
        socket.emit('promptSuitChange', {
          gameCode,
          card,
          currentSuit: game.current_suit
        });
      } else {
        throw new Error('This card does not require options');
      }
    } catch (error) {
      console.error('Card options error:', error);
      socket.emit('error', error.message);
    }
  });

  socket.on('passTurn', async ({ gameCode, playerNumber, hasDrawn }) => {
    try {
      const game = activeGames.get(gameCode);
      if (!game) throw new Error('Game not found');
      if (game.current_player !== playerNumber) throw new Error("It's not your turn");
      if (!game.has_drawn) throw new Error("You must draw a card before passing");

      const nextPlayer = playerNumber === 1 ? 2 : 1;
      
      const updateData = {
        current_player: nextPlayer,
        has_drawn: false,
        updated_at: new Date().toISOString(),
        last_move_timestamp: new Date().toISOString()
      };

      const { data: updatedGame, error } = await supabase
        .from('cards_game')
        .update(updateData)
        .eq('code', gameCode)
        .select()
        .single();

      if (error) throw error;
      activeGames.set(gameCode, updatedGame);

      io.to(gameCode).emit('gameUpdate', {
        success: true,
        gameState: updatedGame,
        message: `Player ${playerNumber} passed their turn`
      });
    } catch (error) {
      console.error('Pass turn error:', error);
      socket.emit('error', error.message);
    }
  });

  socket.on('drawCard', async ({ gameCode, playerNumber }) => {
    try {
      const game = activeGames.get(gameCode);
      if (!game) throw new Error('Game not found');
      if (game.current_player !== playerNumber) throw new Error("It's not your turn");

      const result = await processDrawCard(gameCode, playerNumber);
      io.to(gameCode).emit('gameUpdate', result);
    } catch (error) {
      console.error('Draw card error:', error);
      socket.emit('error', error.message);
    }
  });

// Update the disconnect handler
socket.on('disconnect', () => {
  if (!socket.gameCode) return;
  const gameCode = socket.gameCode;
  const playerNumber = socket.playerNumber;

  // Get the current game state
  const game = activeGames.get(gameCode);
  if (!game) return;

  // Only handle player 1 (creator) disconnecting
  if (playerNumber === 1) {
    // Check if player 2 has NOT joined yet
    if (!game.player2_phone) {
      // Immediately mark as abandoned since creator left before anyone joined
      endGame(gameCode, null, 'abandoned')
        .then(() => {
          io.to(gameCode).emit('gameOver', {
            winner: null,
            reason: 'Game creator left before anyone joined',
            payout: 0
          });
        })
        .catch(error => {
          console.error('Failed to mark game as abandoned:', error);
        });
    }
  }

  // Clear any existing timer for this game
  if (disconnectTimers.has(gameCode)) {
    clearTimeout(disconnectTimers.get(gameCode));
    disconnectTimers.delete(gameCode);
  }

  // Update room state
  const room = gameRooms.get(gameCode);
  if (room) {
    room[`player${playerNumber}`] = null;
    
    // Check if both players have disconnected
    if (!room.player1 && !room.player2) {
      // Mark game as abandoned if it's still ongoing
      if (game.status === 'ongoing') {
        endGame(gameCode, null, 'abandoned')
          .then(() => {
            io.to(gameCode).emit('gameOver', {
              winner: null,
              reason: 'Game abandoned - both players left',
              payout: 0
            });
          })
          .catch(error => {
            console.error('Failed to mark game as abandoned:', error);
          });
      }
    }
  }

  console.log(`Player ${playerNumber} disconnected from game ${gameCode}`);
});

  socket.on('reconnect', async () => {
    if (!socket.gameCode) return;
    const gameCode = socket.gameCode;
    const playerNumber = socket.playerNumber;

    // Update room with reconnected socket
    const room = gameRooms.get(gameCode);
    if (room) {
      room[`player${playerNumber}`] = socket.id;
      io.to(gameCode).emit('playerReconnected', { playerNumber });
      
      // Send current game state to reconnected player
      const game = activeGames.get(gameCode);
      if (game) {
        socket.emit('gameState', game);
      }
    }
  });
});

// Game management functions
async function getOrCreateGame(gameCode) {
  let game = activeGames.get(gameCode);
  if (game) return game;

  const { data: existingGame, error } = await supabase
    .from('cards_game')
    .select('*')
    .eq('code', gameCode)
    .single();

  if (!error && existingGame) {
    activeGames.set(gameCode, existingGame);
    return existingGame;
  }

  const deck = shuffleDeck(generateDeck());
  const newGame = {
    code: gameCode,
    player1_cards: deck.splice(0, 7),
    player2_cards: deck.splice(0, 7),
    deck_cards: deck,
    discard_pile: [],
    current_player: 1,
    current_suit: null,
    status: 'waiting',
    created_at: new Date().toISOString()
  };

  const { data: createdGame, error: createError } = await supabase
    .from('cards_game')
    .insert(newGame)
    .select()
    .single();

  if (createError) throw createError;
  activeGames.set(gameCode, createdGame);
  return createdGame;
}

async function processCardPlay(gameCode, card, playerNumber, options = {}) {
  const game = activeGames.get(gameCode);
  if (!game) throw new Error('Game not found');

  const playerCards = game[`player${playerNumber}_cards`];
  const topDiscard = game.discard_pile.length > 0 ? 
    game.discard_pile[game.discard_pile.length - 1] : null;

  const cardIndex = playerCards.findIndex(c => 
    c.suit === card.suit && c.value === card.value);
  if (cardIndex === -1) throw new Error('You do not have this card');

  if (topDiscard && !['8', 'J', 'A'].includes(card.value)) {
    if ((card.value === '2' && topDiscard.value === '2') || 
        (card.value === 'A' && card.suit === 'spades')) {
        // Allowed
    } 
    else if (card.suit !== game.current_suit && card.value !== topDiscard.value&&card.value!=='J'&&card.value!=='8') {
      throw new Error('Card must match suit or value of the top discard');
    }
  }

  let specialEffect = null;
  let nextPlayer = playerNumber === 1 ? 2 : 1;
  let cardsToDiscard = [card];
  let drawCards = 0;
  let newSuit = card.suit;
  let isSuitChangeBlocked = false; // Initialize the flag

  switch (card.value) {
    case '5':
      specialEffect = 'skip';
      nextPlayer = playerNumber;
      break;

    case '7':
      if (options.playAlone) {
        specialEffect = 'skip';
        nextPlayer = playerNumber;
      } else {
        if (!options.additionalCards) throw new Error('No additional cards selected');
        const additionalCards = options.additionalCards.filter(c => 
          c.suit === card.suit && playerCards.some(pc => 
            pc.suit === c.suit && pc.value === c.value||c.value==='J'||c.value==='8'));
        cardsToDiscard = [card, ...options.additionalCards];
        specialEffect = 'multi_discard';
      }
      break;

    case 'A':
      if (card.suit === 'spades') {
        if (game.pending_draw) {
          drawCards = game.pending_draw + 5;
        } else {
          drawCards = 5;
        }
        specialEffect = 'draw_cards';
      }
      break;

    case '2':
      if (card.suit === 'spades' && game.pending_draw) {
        drawCards = game.pending_draw + 2;
        specialEffect = 'draw_cards';
      } else {
        if (game.pending_draw) {
          drawCards = game.pending_draw + 2;
        } else {
          drawCards = 2;
        }
        specialEffect = 'draw_cards';
      }
      break;

    case '8':
    case 'J':
      if (!options.newSuit) {
        return {
          needsSuitChoice: true,
          card: card,
          possibleSuits: ['hearts', 'diamonds', 'clubs', 'spades'].filter(s => s !== card.suit)
        };
      }
      specialEffect = 'change_suit';
      newSuit = options.newSuit;
      isSuitChangeBlocked = true; // Set to true when 8 or J is played
      break;

    default:
      // For all other cards, ensure suit change is not blocked
      isSuitChangeBlocked = false;
      break;
  }

  const updatedPlayerCards = [...playerCards];
  for (const cardToRemove of cardsToDiscard) {
    const index = updatedPlayerCards.findIndex(c => 
      c.suit === cardToRemove.suit && c.value === cardToRemove.value);
    if (index !== -1) {
      updatedPlayerCards.splice(index, 1);
    }
  }

  const updatedDiscardPile = [...game.discard_pile, ...cardsToDiscard];
  
  const updateData = {
    [`player${playerNumber}_cards`]: updatedPlayerCards,
    discard_pile: updatedDiscardPile,
    current_player: nextPlayer,
    current_suit: newSuit,
    has_drawn: false,
    updated_at: new Date().toISOString(),
    last_move_timestamp: new Date().toISOString(),
    last_suit_change: card.value === '8' || card.value === 'J' ? playerNumber : game.last_suit_change,
    is_suit_change_blocked: isSuitChangeBlocked // Add the flag to update data
  };

  if (specialEffect === 'draw_cards') {
    updateData.pending_draw = drawCards;
  }

  const { data: updatedGame, error } = await supabase
    .from('cards_game')
    .update(updateData)
    .eq('code', gameCode)
    .select()
    .single();

  if (error) throw error;
  activeGames.set(gameCode, updatedGame);

  const response = {
    success: true,
    gameState: updatedGame,
    playedCard: card,
    nextPlayer,
    specialEffect
  };

  if (specialEffect === 'draw_cards') {
    response.drawCards = drawCards;
    response.opponentNumber = nextPlayer;
  } else if (specialEffect === 'change_suit') {
    response.newSuit = newSuit;
  }

  return response;
}

async function processDrawCard(gameCode, playerNumber) {
  const game = activeGames.get(gameCode);
  if (!game) throw new Error('Game not found');
  if (game.has_drawn) throw new Error('You can only draw once per turn');
  
  if (game.deck_cards.length === 0) {
    try {
      await reshuffleDeck(gameCode);
      showNotification('Deck was reshuffled from discard pile');
    } catch (reshuffleError) {
      throw new Error('No cards left to draw and cannot reshuffle');
    }
  }

  let drawCount = 1;
  if (game.pending_draw) {
    drawCount = game.pending_draw;
  }

  const drawnCards = game.deck_cards.slice(0, drawCount);
  const updatedDeck = game.deck_cards.slice(drawCount);
  const updatedPlayerCards = [...game[`player${playerNumber}_cards`], ...drawnCards];

  const updateData = {
    [`player${playerNumber}_cards`]: updatedPlayerCards,
    deck_cards: updatedDeck,
    has_drawn: true,
    pending_draw: null,
    updated_at: new Date().toISOString()
  };

  const { data: updatedGame, error } = await supabase
    .from('cards_game')
    .update(updateData)
    .eq('code', gameCode)
    .select()
    .single();

  if (error) throw error;
  activeGames.set(gameCode, updatedGame);

  return {
    success: true,
    gameState: updatedGame,
    drawnCards,
    playerNumber,
    wasForcedDraw: game.pending_draw !== null
  };
}

async function reshuffleDeck(gameCode) {
  const game = activeGames.get(gameCode);
  if (!game) throw new Error('Game not found');
  
  if (game.discard_pile.length <= 1) {
    throw new Error('Not enough cards to reshuffle');
  }

  const topCard = game.discard_pile.pop();
  const newDeck = shuffleDeck(game.discard_pile);
  
  const updateData = {
    deck_cards: newDeck,
    discard_pile: [topCard],
    updated_at: new Date().toISOString()
  };

  const { data: updatedGame, error } = await supabase
    .from('cards_game')
    .update(updateData)
    .eq('code', gameCode)
    .select()
    .single();

  if (error) throw error;
  activeGames.set(gameCode, updatedGame);
  return updatedGame;
}

async function passTurn(gameCode, playerNumber) {
  const game = activeGames.get(gameCode);
  if (!game) throw new Error('Game not found');
  if (game.current_player !== playerNumber) throw new Error("It's not your turn");
  if (!game.has_drawn) throw new Error("You must draw a card before passing");

  const nextPlayer = playerNumber === 1 ? 2 : 1;
  
  const updateData = {
    current_player: nextPlayer,
    has_drawn: false,
    updated_at: new Date().toISOString(),
    last_move_timestamp: new Date().toISOString()
  };

  const { data: updatedGame, error } = await supabase
    .from('cards_game')
    .update(updateData)
    .eq('code', gameCode)
    .select()
    .single();

  if (error) throw error;
  activeGames.set(gameCode, updatedGame);

  return {
    success: true,
    gameState: updatedGame,
    nextPlayer
  };
}

async function endGame(gameCode, winner, reason) {
  const game = activeGames.get(gameCode);
  if (!game) throw new Error('Game not found');


  // First check if both players have paid their bets
  if (game.bet && winner) {
    if (!game.player1_bet_deducted || !game.player2_bet_deducted) {
      // If bets weren't deducted properly, refund any deducted amounts
      try {
        if (game.player1_bet_deducted && game.player1_auth_token) {
          const wallet = new GameWallet(game.player1_auth_token);
          await wallet.processCredit({
            transaction_id: `REFUND_${game.player1_bet_transaction_id}`,
            round_id: `${gameCode}`,
            user_id: game.player1_phone,
            username: game.player1_username || 'cards_player1',
            amount: game.bet,
            game: 'crazy',
            transaction_type: 'credit',
            status: "completed",
            metadata: {
              original_transaction: game.player1_bet_transaction_id,
              reason: 'incomplete_bets'
            }
          });
        }

        if (game.player2_bet_deducted && game.player2_auth_token) {
          const wallet = new GameWallet(game.player2_auth_token);
          await wallet.processCredit({
            transaction_id: `REFUND_${game.player2_bet_transaction_id}`,
            round_id: `${gameCode}`,
            user_id: game.player2_phone,
            username: game.player2_username || 'cards_player2',
            amount: game.bet,
            game: 'crazy',
            transaction_type: 'credit',
            status: "completed",
            metadata: {
              original_transaction: game.player2_bet_transaction_id,
              reason: 'incomplete_bets'
            }
          });
        }

        // Update game status to reflect incomplete bets
        const updateData = {
          status: 'cancelled',
          winner: null,
          result: 'incomplete_bets',
          ended_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          payout_amount: null,
          house_fee: null
        };

        const { data: endedGame, error } = await supabase
          .from('cards_game')
          .update(updateData)
          .eq('code', gameCode)
          .select()
          .single();

        if (error) throw error;

        cleanupGameResources(gameCode);
        io.to(gameCode).emit('gameOver', {
          winner: null,
          reason: 'Game cancelled - bets not properly deducted',
          payout: 0,
          message: 'Bets have been refunded'
        });

        return endedGame;
      } catch (refundError) {
        console.error('Refund failed:', refundError);
        throw new Error('Failed to process incomplete bets refund');
      }
    }

    // Proceed with normal payout if both bets were deducted
    const winnerPhone = game[`player${winner}_phone`];
    const winnerAuthToken = game[`player${winner}_auth_token`];
    const winnerUsername = game[`player${winner}_username`] || 'cards_player';
    const winnerSocket = playerConnections.get(gameCode)?.[`player${winner}`];

    if (winnerPhone && winnerAuthToken) {
      try {
        const wallet = new GameWallet(winnerAuthToken);
        const payoutAmount = game.bet * 1.8;
        const transactionId = `CARDS_WIN_${gameCode}_${Date.now()}`;
        
        const creditResult = await wallet.processCredit({
          transaction_id: transactionId,
          round_id: gameCode,
          user_id: winnerPhone,
          username: winnerUsername,
          amount: payoutAmount,
          game: 'crazy',
          transaction_type: 'credit',
          status: 'completed',
          metadata: {
            original_bet: game.bet,
            house_fee: game.bet * 0.2,
            net_winnings: payoutAmount - game.bet,
            game_type: 'cards',
            winner: winnerPhone
          }
        });

        if (!creditResult.success) {
          throw new Error(`Failed to credit winnings: ${creditResult.error}`);
        }

        if (winnerSocket) {
          io.to(winnerSocket).emit('payout', {
            amount: payoutAmount,
            newBalance: creditResult.data.newBalance,
            message: `You won ${payoutAmount} ETB! (${game.bet * 0.8} ETB profit after fee)`
          });
        }

      } catch (payoutError) {
        console.error('Payout failed:', payoutError);
        await supabase
          .from('failed_payouts')
          .insert([{
            game_code: gameCode,
            winner: winnerPhone,
            amount: game.bet * 1.8,
            error: payoutError.message,
            transaction_id: transactionId || 'UNKNOWN',
            resolved: false
          }]);
        throw payoutError;
      }
    }
  }

  const updateData = {
    status: 'finished',
    winner: winner ? `player${winner}` : null,
    result: reason,
    ended_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    payout_amount: game.bet && winner ? game.bet * 1.8 : null,
    house_fee: game.bet && winner ? game.bet * 0.2 : null
  };
    if (reason === 'abandoned') {
    updateData.player1_bet_deducted = false;
    updateData.player2_bet_deducted = false;
    updateData.payout_amount = null;
    updateData.house_fee = null;
  }

  const { data: endedGame, error } = await supabase
    .from('cards_game')
    .update(updateData)
    .eq('code', gameCode)
    .select()
    .single();

  if (error) {
    console.error('Failed to update game status:', error);
    throw error;
  }

  cleanupGameResources(gameCode);
  return endedGame;
}
function checkGameEndConditions(gameCode, gameState) {

    if (!gameState || !gameState.player1_cards || !gameState.player2_cards) {
    console.error('Invalid game state:', gameState);
    return; // Exit early if state is invalid
  }
  if (gameState.player1_cards.length === 0) {
    endGame(gameCode, 1, 'win')
      .then(() => {
        io.to(gameCode).emit('gameOver', { 
          winner: 1, 
          reason: 'Player 1 has no cards left',
          payout: gameState.bet ? gameState.bet * 1.8 : 0,
          betVerified: gameState.bet ? 
            (gameState.player1_bet_deducted && gameState.player2_bet_deducted) : 
            null
        });
      })
      .catch(error => {
        console.error('Game end error:', error);
        if (error.message.includes('incomplete_bets')) {
          io.to(gameCode).emit('gameCancelled', {
            reason: 'Bets not properly deducted',
            refundsIssued: true,
            message: 'Game cancelled. Any deducted amounts have been refunded.'
          });
        } else {
          io.to(gameCode).emit('gameError', {
            message: 'Error ending game: ' + error.message,
            isRecoverable: false
          });
        }
      });
  } 
  else if (gameState.player2_cards.length === 0) {
    endGame(gameCode, 2, 'win')
      .then(() => {
        io.to(gameCode).emit('gameOver', { 
          winner: 2, 
          reason: 'Player 2 has no cards left',
          payout: gameState.bet ? gameState.bet * 1.8 : 0,
          betVerified: gameState.bet ? 
            (gameState.player1_bet_deducted && gameState.player2_bet_deducted) : 
            null
        });
      })
      .catch(error => {
        console.error('Game end error:', error);
        if (error.message.includes('incomplete_bets')) {
          io.to(gameCode).emit('gameCancelled', {
            reason: 'Bets not properly deducted',
            refundsIssued: true,
            message: 'Game cancelled. Any deducted amounts have been refunded.'
          });
        } else {
          io.to(gameCode).emit('gameError', {
            message: 'Error ending game: ' + error.message,
            isRecoverable: false
          });
        }
      });
  }
  else if (gameState.deck_cards.length === 0) {
    const player1CanPlay = canPlayerPlay(gameState.player1_cards, gameState.current_suit);
    const player2CanPlay = canPlayerPlay(gameState.player2_cards, gameState.current_suit);
    
    if (!player1CanPlay && !player2CanPlay) {
      const player1HasSpecial = gameState.player1_cards.some(c => ['8', 'J'].includes(c.value));
      const player2HasSpecial = gameState.player2_cards.some(c => ['8', 'J'].includes(c.value));
      
      if (!player1HasSpecial && !player2HasSpecial) {
        if (gameState.bet) {
          // Check if bets were properly deducted before returning them
          if (gameState.player1_bet_deducted || gameState.player2_bet_deducted) {
            returnBets(gameCode)
              .then(() => {
                endGame(gameCode, null, 'draw')
                  .then(() => {
                    io.to(gameCode).emit('gameOver', { 
                      winner: null, 
                      reason: 'No valid moves left',
                      payout: 0,
                      message: 'Game ended in a draw. Bets returned to both players.',
                      betVerified: true
                    });
                  });
              })
              .catch(error => {
                console.error('Return bets error:', error);
                io.to(gameCode).emit('gameError', {
                  message: 'Failed to return bets: ' + error.message,
                  isRecoverable: false
                });
              });
          } else {
            // No bets were deducted, just end the game
            endGame(gameCode, null, 'draw')
              .then(() => {
                io.to(gameCode).emit('gameOver', { 
                  winner: null, 
                  reason: 'No valid moves left',
                  payout: 0,
                  message: 'Game ended in a draw',
                  betVerified: false
                });
              });
          }
        } else {
          endGame(gameCode, null, 'draw')
            .then(() => {
              io.to(gameCode).emit('gameOver', { 
                winner: null, 
                reason: 'No valid moves left',
                payout: 0,
                betVerified: null
              });
            });
        }
      }
    }
  }
}

async function returnBets(gameCode) {
  const game = activeGames.get(gameCode);
  if (!game) throw new Error('Game not found');
  
  if (game.player1_phone && game.player1_auth_token && game.bet) {
    const wallet = new GameWallet(game.player1_auth_token);
    await wallet.processCredit({
      user_id: game.player1_phone,
      username: game.player1_username || 'cards_player',
      amount: game.bet,
      game: 'crazy',
      round_id: gameCode,
      transaction_id: `REFUND_${gameCode}_P1_${Date.now()}`,
      metadata: {
        reason: 'game_draw'
      }
    });
  }

  if (game.player2_phone && game.player2_auth_token && game.bet) {
    const wallet = new GameWallet(game.player2_auth_token);
    await wallet.processCredit({
      user_id: game.player2_phone,
      username: game.player2_username || 'cards_player',
      amount: game.bet,
      game: 'crazy',
      round_id: gameCode,
      transaction_id: `REFUND_${gameCode}_P2_${Date.now()}`,
      metadata: {
        reason: 'game_draw'
      }
    });
  }
}

function canPlayerPlay(cards, currentSuit) {
  return cards.some(card => 
    card.suit === currentSuit || 
    (currentSuit && card.value === currentSuit.value)
  );
}

app.get('/api/game-status', async (req, res) => {
  const { code } = req.query;
  
  try {
    const { data: game, error } = await supabase
      .from('cards_game')
      .select('player1_bet_deducted, player2_bet_deducted')
      .eq('code', code)
      .single();

    if (error) throw error;
    if (!game) return res.status(404).json({ error: 'Game not found' });

    res.json({
      player1_bet_deducted: game.player1_bet_deducted,
      player2_bet_deducted: game.player2_bet_deducted
    });
  } catch (error) {
    console.error('Game status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use((err, req, res, next) => {
  if (err.message.includes('wallet') || err.message.includes('transaction')) {
    console.error('Wallet transaction error:', err);
    supabase
      .from('transaction_errors')
      .insert([{
        endpoint: req.originalUrl,
        error: err.message,
        game_code: req.body?.gameCode,
        user_id: req.body?.userId,
        resolved: false
      }]);
    
    return res.status(500).json({ 
      error: 'Transaction processing failed',
      code: 'WALLET_ERROR',
      shouldRetry: true
    });
  }
  next(err);
});

app.get('/api/cards/games', async (req, res) => {
  try {
    const { data: games, error } = await supabase
      .from('cards_game')
      .select('code, player1_username, bet, created_at, is_private')
      .eq('status', 'waiting')
      .eq('is_private', false)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(games || []);
  } catch (error) {
    console.error('Error fetching games:', error);
    res.status(500).json({ error: 'Failed to fetch games' });
  }
});

app.post('/api/cards/games', async (req, res) => {
  try {
    const { bet, isPrivate, token, userId, username } = req.body;
    
    if (bet && (isNaN(bet) || bet <= 0)) {
      throw new Error('Invalid bet amount');
    }

    const gameCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const deck = shuffleDeck(generateDeck());
    const player1Cards = deck.splice(0, 7);
    const player2Cards = deck.splice(0, 7);
    
    const { data: game, error } = await supabase
      .from('cards_game')
      .insert([{
        code: gameCode,
        player1_phone: userId,
        player1_username: username,
        player1_auth_token: token,
        player1_cards: player1Cards,
        player2_cards: player2Cards,
        deck_cards: deck,
        discard_pile: [],
        current_player: 1,
        bet: bet,
        pot: bet,
        is_private: isPrivate,
        status: 'waiting',
        player1_bet_deducted: false,
        player2_bet_deducted: false,
        player1_bet_transaction_id: null,
        player2_bet_transaction_id: null,
        player1_timeouts: 0,
        player2_timeouts: 0
      }])
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, game });
  } catch (error) {
    console.error('Error creating game:', error);
    res.status(500).json({ 
      success: false,
      error: error.message,
      code: error.code || 'GAME_CREATION_FAILED'
    });
  }
});

app.post('/api/cards/games/:code/join', async (req, res) => {
  try {
    const gameCode = req.params.code;
    const { token, userId, username } = req.body;
    
    const { data: game, error: fetchError } = await supabase
      .from('cards_game')
      .select('*')
      .eq('code', gameCode)
      .single();

    if (fetchError || !game) throw new Error('Game not found');
    
    if (game.status === 'finished') {
      return res.status(400).json({ 
        success: false,
        error: 'This game has already finished',
        code: 'GAME_ALREADY_OVER'
      });
    }
    
    if (game.status !== 'waiting') throw new Error('Game already started');
    if (game.player1_phone === userId) throw new Error('Cannot join your own game');
    
    const { data: updatedGame, error: updateError } = await supabase
      .from('cards_game')
      .update({
        player2_phone: userId,
        player2_username: username,
        player2_auth_token: token,
        status: 'ongoing',
        pot: game.bet * 2
      })
      .eq('code', gameCode)
      .select()
      .single();

    if (updateError) throw updateError;
    res.json({ success: true, game: updatedGame });
  } catch (error) {
    console.error('Error joining game:', error);
    res.status(500).json({ 
      success: false,
      error: error.message,
      code: error.code || 'JOIN_GAME_FAILED'
    });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.get('/', (req, res) => {
  res.send('Cards Game Server is running 🚀');
});

function checkBetsAndSendState(gameCode, socket) {
  // Implementation depends on your specific requirements
  // This is a placeholder for the actual implementation
  socket.emit('gameState', activeGames.get(gameCode));
}

function showNotification(message) {
  // Implementation depends on your notification system
  console.log('Notification:', message);
}
