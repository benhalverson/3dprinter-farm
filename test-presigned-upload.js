/**
 * Test script for Slant3D V2 presigned upload workflow
 * This script demonstrates the complete file upload and estimate process
 *
 * Usage: node test-presigned-upload.js <path-to-stl-file>
 * Example: node test-presigned-upload.js ./test-cube.stl
 */

import fs from 'fs';
import path from 'path';

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8787';
const STL_FILE = process.argv[2] || 'test-model.stl';
const OWNER_ID = process.env.OWNER_ID || `test-user-${Date.now()}`;

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function log(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function main() {
  try {
    console.log('\n');
    log('blue', '========================================');
    log('blue', 'Slant3D V2 Presigned Upload Test');
    log('blue', '========================================');
    console.log('');
    log('green', `API Base URL: ${API_BASE_URL}`);
    log('green', `STL File: ${STL_FILE}`);
    log('green', `Owner ID: ${OWNER_ID}`);
    console.log('');

    // Check if STL file exists
    if (!fs.existsSync(STL_FILE)) {
      log('red', `Error: STL file not found: ${STL_FILE}`);
      console.log('');
      console.log('Usage: node test-presigned-upload.js <path-to-stl-file>');
      console.log('Example: node test-presigned-upload.js ./models/dragon.stl');
      console.log('');
      console.log('You can download a sample STL file:');
      console.log('  curl -o test-cube.stl https://raw.githubusercontent.com/3DprintFIT/hedgehog/master/stl/calibration_cube.stl');
      process.exit(1);
    }

    const fileName = path.basename(STL_FILE);
    const fileBuffer = fs.readFileSync(STL_FILE);

    // Step 1: Request presigned upload URL
    log('yellow', '\nStep 1: Request presigned upload URL');
    console.log(`POST ${API_BASE_URL}/v2/presigned-upload\n`);

    const presignedResponse = await fetch(`${API_BASE_URL}/v2/presigned-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: fileName,
        ownerId: OWNER_ID,
      }),
    });

    const presignedData = await presignedResponse.json();
    log('green', 'Response:');
    console.log(JSON.stringify(presignedData, null, 2));

    if (!presignedData.success) {
      log('red', 'Error: Failed to get presigned URL');
      process.exit(1);
    }

    const { presignedUrl, filePlaceholder, key } = presignedData.data;
    log('green', '\n✓ Presigned URL obtained');
    log('blue', `Key: ${key}`);
    console.log('');

    // Step 2: Upload file to presigned URL
    log('yellow', 'Step 2: Upload STL file to presigned URL');
    console.log(`PUT ${presignedUrl}\n`);

    const uploadResponse = await fetch(presignedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fileBuffer,
    });

    if (uploadResponse.ok) {
      log('green', `✓ File uploaded successfully (HTTP ${uploadResponse.status})`);
    } else {
      log('red', `Error: Upload failed (HTTP ${uploadResponse.status})`);
      const errorText = await uploadResponse.text();
      console.log(errorText);
      process.exit(1);
    }
    console.log('');

    // Step 3: Confirm upload
    log('yellow', 'Step 3: Confirm upload with Slant3D');
    console.log(`POST ${API_BASE_URL}/v2/confirm\n`);

    const confirmResponse = await fetch(`${API_BASE_URL}/v2/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePlaceholder }),
    });

    const confirmData = await confirmResponse.json();
    log('green', 'Response:');
    console.log(JSON.stringify(confirmData, null, 2));

    if (!confirmData.success) {
      log('red', 'Error: Failed to confirm upload');
      process.exit(1);
    }

    const { publicFileServiceId, fileURL, STLMetrics } = confirmData.data;
		console.log('uploaded publicFileServiceId:', publicFileServiceId);
    log('green', '\n✓ Upload confirmed');
    log('blue', `Public File Service ID: ${publicFileServiceId}`);
    log('blue', `File URL: ${fileURL}`);

    if (STLMetrics) {
      console.log('');
      log('green', 'STL Metrics:');
      console.log(JSON.stringify(STLMetrics, null, 2));
    }
    console.log('');

    // Step 4: Estimate price
    log('yellow', 'Step 4: Estimate print cost');
    console.log(`POST ${API_BASE_URL}/v2/estimate\n`);

    // Test with PLA BLACK, quantity 1
    log('blue', 'Testing estimate with PLA BLACK, quantity 1');
    const estimateResponse = await fetch(`${API_BASE_URL}/v2/estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicFileServiceId: publicFileServiceId,
        options: {
          filamentId: '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
          quantity: 1,
          slicer: {
            support_enabled: true,
          },
        },
      }),
    });

    const estimateData = await estimateResponse.json();
    log('green', 'Response:');
    console.log(JSON.stringify(estimateData, null, 2));

    if (!estimateData.success) {
      log('red', 'Error: Failed to estimate price');
      process.exit(1);
    }

    const estimatedCost = estimateData.data.estimatedCost;
    log('green', '\n✓ Price estimated successfully');
    log('blue', `Estimated cost: $${estimatedCost}`);
    console.log('');

    // Test with quantity 10
    log('blue', 'Testing estimate with quantity 10');
    const bulkEstimateResponse = await fetch(`${API_BASE_URL}/v2/estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicFileServiceId: publicFileServiceId,
        options: {
          filamentId: '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
          quantity: 10,
        },
      }),
    });

    const bulkData = await bulkEstimateResponse.json();
    const bulkCost = bulkData.data.estimatedCost;
    log('blue', `Bulk estimate (10 units): $${bulkCost}`);
    console.log('');

    // Summary
    log('blue', '========================================');
    log('green', '✓ All tests completed successfully!');
    log('blue', '========================================');
    console.log('');
    console.log('Summary:');
    console.log(`  File: ${fileName}`);
    console.log(`  Public File Service ID: ${publicFileServiceId}`);
    console.log(`  Single unit cost: $${estimatedCost}`);
    console.log(`  Bulk cost (10 units): $${bulkCost}`);
    console.log('');
    log('yellow', 'You can now use this publicFileServiceId to:');
    console.log('  - Get more estimates with different filaments');
    console.log('  - Place orders using the Slant3D order API');
    console.log('');
    log('yellow', 'Example estimate request:');
    console.log(`fetch('${API_BASE_URL}/v2/estimate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    publicFileServiceId: '${publicFileServiceId}',
    options: {
      filamentId: '8cfbf30a-2995-486e-a1e8-8f7d41488f1e', // PLA BLUE
      quantity: 5
    }
  })
});`);
    console.log('');

  } catch (error) {
    log('red', `\nError: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

main();
