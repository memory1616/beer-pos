/**
 * scripts/build-vendor.js
 * Copies third-party library bundles to public/js/vendor/
 * Run: npm run build:vendor
 */
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'node_modules');
const destDir = path.join(__dirname, '..', 'public', 'js', 'vendor');

// Ensure destination exists
fs.mkdirSync(destDir, { recursive: true });

const vendors = [
  { name: 'chart.js', file: 'chart.js/dist/chart.umd.min.js' }
];

vendors.forEach(({ name, file }) => {
  const src = path.join(srcDir, file);
  const dest = path.join(destDir, path.basename(file));

  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${name} -> public/js/vendor/${path.basename(file)}`);
  } else {
    console.warn(`Warning: ${name} not found at ${src}`);
  }
});

console.log('Vendor build complete.');
