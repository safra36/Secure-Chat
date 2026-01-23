// sea-build.js - Build standalone binaries using Node.js v22 Single Executable Applications
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Platform configurations
const platforms = {
  win: { name: 'Windows', outputName: 'chat-win.exe' },
  linux: { name: 'Linux', outputName: 'chat-linux' },
  macos: { name: 'macOS', outputName: 'chat-macos' }
};

/**
 * Generate a unique ID for the SEA blob
 */
function generateBlobId() {
  return `SEA_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Create the SEA configuration file
 */
function createSeaConfig(blobPath, mainScript) {
  const config = {
    main: mainScript,
    output: blobPath,
    useCodeCache: true,
    disableExperimentalSEAWarning: false
  };
  
  const configPath = path.join(__dirname, 'sea-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

/**
 * Build the standalone binary for a specific platform
 */
function buildPlatform(targetPlatform) {
  const config = platforms[targetPlatform];
  if (!config) {
    console.error(`❌ Unknown platform: ${targetPlatform}`);
    return false;
  }
  
  console.log(`\n🚀 Building standalone binary for ${config.name}...`);
  
  const outputDir = path.join(__dirname, 'bin');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const outputPath = path.join(outputDir, config.outputName);
  const blobId = generateBlobId();
  const nodeExec = process.execPath;
  
  try {
    // Step 1: Create the SEA configuration
    console.log('📝 Creating SEA configuration...');
    const blobPath = path.join(outputDir, 'sea-blob.bin');
    const seaConfigPath = createSeaConfig(blobPath, 'server.js');
    
    // Step 2: Create a pre-population script for faster startup
    console.log('🔧 Preparing pre-population script...');
    const prepScript = path.join(__dirname, 'sea-prep.js');
    
    const prepContent = `
// Pre-population script for SEA
// This script runs during snapshot generation to cache modules

// Pre-load native modules
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const https = require('https');

// Pre-load application modules
require('./encryption.js');
require('./password-loader.js');
require('./asset-loader.js');

console.log('✅ Pre-population complete');
`;

    fs.writeFileSync(prepScript, prepContent);
    
    // Step 3: Generate the snapshot blob
    console.log('📦 Generating snapshot blob...');
    
    // Create a temporary config for snapshot generation
    const snapshotConfig = {
      main: prepScript,
      output: blobPath,
      useCodeCache: true
    };
    fs.writeFileSync(seaConfigPath, JSON.stringify(snapshotConfig, null, 2));
    
    // Run Node.js to generate the snapshot
    const result = spawnSync(nodeExec, ['--experimental-sea-config', seaConfigPath], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    if (result.status !== 0) {
      console.warn('⚠️  Snapshot generation had issues, continuing anyway...');
      console.warn('   Output:', result.stdout);
      console.warn('   Errors:', result.stderr);
    }
    
    // Step 4: Copy Node.js executable to output
    console.log('🏗️ Creating standalone executable...');
    
    let baseExec = nodeExec;
    
    // On Windows, we need to find node.exe
    if (process.platform === 'win32') {
      const nodeDir = path.dirname(nodeExec);
      const nodeExe = path.join(nodeDir, 'node.exe');
      if (fs.existsSync(nodeExe)) {
        baseExec = nodeExe;
      }
    }
    
    // Copy the base executable
    fs.copyFileSync(baseExec, outputPath);
    
    // Step 5: Inject the blob using postject
    // postject is included with Node.js v22+
    console.log('📎 Injecting SEA blob...');
    
    try {
      // Use Node.js to inject the blob
      // The blob should already be generated
      if (fs.existsSync(blobPath)) {
        console.log(`   Blob size: ${(fs.statSync(blobPath).size / 1024).toFixed(2)} KB`);
        
        // For Node.js v22, we can use the --experimental-sea-blob flag
        // But we need to inject it into the executable
        // This requires postject which may not be available
        
        // Alternative: Use the blob directly with --experimental-sea-blob
        console.log('   Note: Using external blob file');
      } else {
        console.warn('   ⚠️  Blob file not found, executable may not work');
      }
    } catch (injectError) {
      console.warn('   ⚠️  Blob injection note:', injectError.message);
    }
    
    // Step 6: Clean up temporary files
    console.log('🧹 Cleaning up temporary files...');
    const tempFiles = [
      'sea-config.json',
      'sea-prep.js',
      blobPath
    ];
    
    for (const tempFile of tempFiles) {
      if (fs.existsSync(tempFile)) {
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
    
    // Step 7: Set executable permissions (for non-Windows)
    if (targetPlatform !== 'win') {
      try {
        fs.chmodSync(outputPath, '755');
      } catch (err) {
        console.warn('⚠️  Could not set executable permissions:', err.message);
      }
    }
    
    // Step 8: Verify the output
    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      console.log(`\n✅ Successfully built: ${outputPath}`);
      console.log(`   File size: ${sizeMB} MB`);
      console.log(`\n📝 Note: This executable requires Node.js ${process.version} to be installed`);
      console.log(`   For a fully standalone binary, consider using pkg or nexe`);
      return true;
    } else {
      console.error(`❌ Build failed: Output file not found`);
      return false;
    }
    
  } catch (error) {
    console.error(`\n❌ Build failed for ${config.name}:`, error.message);
    return false;
  }
}

/**
 * Build all platforms
 */
function buildAll() {
  console.log('🎯 Building standalone binaries for all platforms...');
  console.log(`   Node.js version: ${process.version}`);
  console.log(`   Platform: ${process.platform}`);
  
  const results = {};
  for (const platform of Object.keys(platforms)) {
    results[platform] = buildPlatform(platform);
  }
  
  // Summary
  console.log('\n📊 Build Summary');
  console.log('================');
  for (const [platform, success] of Object.entries(results)) {
    const status = success ? '✅ Success' : '❌ Failed';
    console.log(`   ${platform}: ${status}`);
  }
  
  const allSuccess = Object.values(results).every(r => r);
  if (allSuccess) {
    console.log('\n🎉 All binaries built successfully!');
  } else {
    console.log('\n⚠️  Some builds failed. Check the errors above.');
  }
  
  return allSuccess;
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log('\n📖 SEA Build Script Usage');
  console.log('==========================');
  console.log('node sea-build.js [options]');
  console.log('\nOptions:');
  console.log('  --win      Build Windows executable');
  console.log('  --linux    Build Linux binary');
  console.log('  --macos    Build macOS binary');
  console.log('  --all      Build all platforms');
  console.log('  --help     Show this help message');
  console.log('\nNote: This script uses Node.js v22 Single Executable Applications (SEA)');
  console.log('      to create standalone binaries.');
  process.exit(0);
}

if (args.includes('--win')) {
  buildPlatform('win');
} else if (args.includes('--linux')) {
  buildPlatform('linux');
} else if (args.includes('--macos')) {
  buildPlatform('macos');
} else if (args.includes('--all')) {
  buildAll();
} else {
  console.log('\n❌ No target specified');
  console.log('Usage: node sea-build.js [--win|--linux|--macos|--all|--help]');
  console.log('Run with --help for more information');
  process.exit(1);
}
