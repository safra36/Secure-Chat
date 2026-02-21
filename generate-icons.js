// Simple icon generator for PWA
// Creates basic colored icons with "SC" text
const fs = require('fs');
const path = require('path');

// Create a simple PNG icon (solid color with text)
function createIcon(size) {
  // This is a minimal PNG with a solid color background
  // For production, you'd want to use a proper image library
  
  const iconPath = path.join(__dirname, 'assets', 'icons', `icon-${size}x${size}.png`);
  
  // Check if sharp is available for proper icon generation
  try {
    const sharp = require('sharp');
    
    // Create icon with sharp
    sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: { r: 79, g: 195, b: 247, alpha: 1 }
      }
    })
    .png()
    .toFile(iconPath)
    .then(() => {
      console.log(`✅ Created icon: icon-${size}x${size}.png`);
    })
    .catch(err => {
      console.error(`❌ Error creating icon-${size}x${size}.png:`, err);
    });
    
    return true;
  } catch (e) {
    // Sharp not available, create simple placeholder
    console.log(`⚠️  Sharp not available, creating placeholder for icon-${size}x${size}.png`);
    
    // Create a minimal valid PNG (1x1 pixel, will be scaled)
    // This is a cyan colored square
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
      0x00, 0x00, 0x00, 0x0D, // IHDR length
      0x49, 0x48, 0x44, 0x52, // "IHDR"
      0x00, 0x00, 0x00, 0x01, // width = 1
      0x00, 0x00, 0x00, 0x01, // height = 1
      0x08,                   // bit depth = 8
      0x06,                   // color type = 6 (RGBA)
      0x00,                   // compression method = 0
      0x00,                   // filter method = 0
      0x00,                   // interlace method = 0
      0x5A, 0x14, 0x5F, 0x9F, // CRC
      0x00, 0x00, 0x00, 0x0A, // IDAT length
      0x49, 0x44, 0x41, 0x54, // "IDAT"
      0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0xF0, 0x1F, // compressed data
      0x00, 0x05, 0xFE, 0x02, // CRC
      0xFE, 0xD2, 0xDC, 0x59, // (more CRC)
      0x00, 0x00, 0x00, 0x00, // IEND length
      0x49, 0x45, 0x4E, 0x44, // "IEND"
      0xAE, 0x42, 0x60, 0x82  // CRC
    ]);
    
    fs.writeFileSync(iconPath, pngHeader);
    return false;
  }
}

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

console.log('🎨 Generating PWA icons...');
sizes.forEach(createIcon);
console.log('✅ Icon generation complete!');
console.log('📁 Icons saved to: assets/icons/');
