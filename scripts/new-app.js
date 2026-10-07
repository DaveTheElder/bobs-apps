#!/usr/bin/env node

/**
 * App Scaffolding Script for Bob's Apps
 * 
 * Usage:
 *   node scripts/new-app.js <name> [options]
 * 
 * Examples:
 *   node scripts/new-app.js weather --icon="🌤️" --desc="Local weather forecast"
 *   node scripts/new-app.js todo-list --icon="✅" --desc="Task management" --sort=7
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Emoji mapping for common words (bash can't pass raw emojis reliably)
const EMOJI_MAP = {
  sun: '🌤️', sunny: '☀️', rain: '🌧️', storm: '⛈️', cloud: '☁️',
  weather: '🌤️', forecast: '🌤️', calendar: '📅', date: '📅',
  todo: '✅', tasks: '✅', check: '✅', list: '📋',
  calculator: '🔢', calc: '🔢', math: '🧮',
  notes: '📝', memo: '📝', write: '✍️',
  timer: '⏱️', clock: '⏰', alarm: '⏰', pomodoro: '🍅',
  color: '🎨', palette: '🎨', paint: '🖌️', design: '🎨',
  converter: '🔄', convert: '🔀', units: '📐', measure: '📏',
  mail: '📧', email: '📨', inbox: '📥', message: '💬', chat: '💬',
  file: '📁', folder: '🗂️', document: '📄', docs: '📑',
  photo: '📷', image: '🖼️', gallery: '🎞️', camera: '📸',
  music: '🎵', audio: '🔊', sound: '🔉', playlist: '🎶',
  video: '🎬', play: '▶️', watch: '👀', stream: '📺',
  game: '🎮', controller: '🕹️', arcade: '👾', puzzle: '🧩',
  settings: '⚙️', gear: '🔧', config: '🛠️', tools: '🔨',
  user: '👤', profile: '👥', people: '👨‍👩‍👧‍👦', team: '🤝',
  star: '⭐', favorite: '❤️', heart: '💖', like: '👍',
  lock: '🔒', security: '🛡️', shield: '🔐', key: '🗝️',
  globe: '🌍', world: '🌎', map: '🗺️', location: '📍',
  book: '📚', library: '📖', read: '📕', learn: '🧠',
  shop: '🛒', cart: '🛍️', buy: '💰', money: '💵', finance: '📊',
};

// Parse arguments (supports both --icon "🌤️" and --icon="🌤️")
function parseArgs(args) {
  const result = { name: null, icon: '📦', desc: '', sort: 0 };
  
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    
    // Handle --key=value format
    if (arg.startsWith('--') && arg.includes('=')) {
      const [key, ...valueParts] = arg.split('=');
      const keyName = key.replace(/^--/, '');
      const value = valueParts.join('=');
      
      switch (keyName) {
        case 'icon': result.icon = resolveEmoji(value || '📦'); break;
        case 'desc': result.desc = value || ''; break;
        case 'sort': result.sort = parseInt(value) || 0; break;
        default: console.log(`Unknown option: --${keyName}`);
      }
    } else if (arg.startsWith('--')) {
      const key = arg.replace(/^--/, '');
      const value = args[i + 1];
      
      switch (key) {
        case 'icon': result.icon = resolveEmoji(value || '📦'); break;
        case 'desc': result.desc = value || ''; break;
        case 'sort': result.sort = parseInt(value) || 0; break;
        default: console.log(`Unknown option: --${key}`);
      }
    } else if (!result.name) {
      result.name = arg;
    }
  }
  
  return result;
}

function resolveEmoji(input) {
  // Since bash can't reliably pass raw emojis, always try word-based resolution first
  const lower = input.toLowerCase().trim();
  
  // Check for exact matches first
  if (EMOJI_MAP[lower]) return EMOJI_MAP[lower];
  
  // Then check for partial matches (word contains key)
  for (const [word, emoji] of Object.entries(EMOJI_MAP)) {
    if (lower.includes(word)) return emoji;
  }
  
  // If input looks like an emoji (contains emoji-range chars), use as-is
  // Use spread operator to properly handle multi-byte Unicode characters
  const firstChar = [...input][0];
  if (/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]$/u.test(firstChar)) {
    return input;
  }
  
  // Fallback to 📦
  return '📦';
}

function main() {
  const config = parseArgs(process.argv.slice(2));
  
  // Validate name
  if (!config.name) {
    console.error('❌ Error: App name is required');
    console.log('\nUsage: node scripts/new-app.js <name> [options]');
    console.log('\nOptions:');
    console.log('  --icon="📦"   Emoji icon (default: 📦)');
    console.log('  --desc=""     App description');
    console.log('  --sort=0      Display order in launcher');
    console.log('\nExamples:');
    console.log('  node scripts/new-app.js weather --icon="🌤️" --desc="Local weather forecast"');
    process.exit(1);
  }
  
  // Validate name format (lowercase, hyphens only)
  if (!/^[a-z][a-z0-9-]*$/.test(config.name)) {
    console.error('❌ Error: Name must start with a letter and contain only lowercase letters, numbers, and hyphens');
    process.exit(1);
  }

  // Auto-resolve emoji from app name if not explicitly provided (default is 📦)
  if (config.icon === '📦') {
    config.icon = resolveEmoji(config.name);
  }
  
  // Convert name to PascalCase for component name
  const componentName = config.name.split('-').map(word => 
    word.charAt(0).toUpperCase() + word.slice(1)
  ).join('');
  
  // Define paths
  const rootDir = path.resolve(__dirname, '..');
  const frontendSrc = path.join(rootDir, 'frontend', 'src');
  const appsDir = path.join(frontendSrc, 'apps');
  const componentPath = path.join(appsDir, `${componentName}.jsx`);
  
  // Check if app already exists
  if (fs.existsSync(componentPath)) {
    console.error(`❌ Error: App "${config.name}" already exists at ${componentPath}`);
    process.exit(1);
  }
  
  // Create apps directory if it doesn't exist
  if (!fs.existsSync(appsDir)) {
    fs.mkdirSync(appsDir, { recursive: true });
  }
  
  // Generate component template
  const componentTemplate = `import React from 'react';

export default function ${componentName}() {
  return (
    <div style={{ maxWidth: '600px', margin: '20px auto' }}>
      <h3>${config.icon} ${componentName.replace(/([A-Z])/g, ' $1').trim()}</h3>
      <p style={{ color: '#6b7080', marginTop: '16px' }}>
        This is the ${config.name.replace(/-/g, ' ')} app. Start building your features here!
      </p>
      
      {/* Add your components below */}
    </div>
  );
}
`;
  
  // Write component file
  fs.writeFileSync(componentPath, componentTemplate);
  console.log(`✅ Created: frontend/src/apps/${componentName}.jsx`);
  
  // Register app in database
  const dbPath = path.join(rootDir, 'bobs-apps.db');
  const db = new sqlite3.Database(dbPath);
  
  db.serialize(() => {
    // Ensure table exists with correct schema
    db.run(`CREATE TABLE IF NOT EXISTS app_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL,
      icon TEXT NOT NULL, description TEXT DEFAULT '', enabled INTEGER DEFAULT 1,
      entry_point TEXT DEFAULT '', sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Insert or ignore the new app
    db.run(
      'INSERT OR IGNORE INTO app_registry (name, icon, description, entry_point, sort_order) VALUES (?, ?, ?, ?, ?)',
      [config.name, config.icon, config.desc || `${componentName.replace(/([A-Z])/g, ' $1').trim()} app`, componentName, config.sort],
      function(err) {
        if (err) {
          console.error(`❌ Error registering in database: ${err.message}`);
          db.close();
          process.exit(1);
        }
        
        const isNew = this.changes > 0;
        console.log(isNew ? '✅ Registered app in database' : 'ℹ️ App already registered in database');
        
        // Update sort_order if provided and not zero
        if (config.sort > 0) {
          db.run('UPDATE app_registry SET sort_order = ? WHERE name = ?', [config.sort, config.name], function(err) {
            if (!err && this.changes > 0) {
              console.log(`✅ Set display order to ${config.sort}`);
            }
            db.close();
          });
        } else {
          db.close();
        }
      }
    );
  });
  
  // Summary
  console.log(`\n🎉 App "${config.name}" created successfully!`);
  console.log('\nTo finish setup:');
  console.log('1. Edit frontend/src/apps/' + componentName + '.jsx to add your features');
  console.log('2. Run "npm run build" in the frontend directory');
  console.log('3. Restart the server if needed');
}

main();
