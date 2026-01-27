// Test file for V2 Add Product endpoint
// Run with: node test-add-product-v2.js

const BASE_URL = 'http://localhost:8787';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'your_jwt_token_here';

const productData = {
  name: 'Test Product V2 - ' + Date.now(),
  description: 'A test 3D printed product using V2 API',
  image: 'https://example.com/image.jpg',
  imageGallery: ['https://example.com/image1.jpg', 'https://example.com/image2.jpg'],
  stl: 'https://your-r2-bucket.r2.dev/test-model.stl',
  filamentType: 'PLA',
  color: 'Black',
  price: 0.15,
  categoryId: 1,
};

async function testAddProductV2() {
  try {
    console.log('\n📋 Testing V2 Add Product Endpoint');
    console.log('=====================================\n');
    console.log(`🔗 URL: POST ${BASE_URL}/v2/add-product`);
    console.log(`🔑 Auth Token: ${AUTH_TOKEN.substring(0, 20)}...`);
    console.log('\n📦 Product Data:');
    console.log(JSON.stringify(productData, null, 2));
    console.log('\n🚀 Sending request...\n');

    const response = await fetch(`${BASE_URL}/v2/add-product`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify(productData),
    });

    const data = await response.json();
    const statusCode = response.status;

    console.log(`📊 Response Status: ${statusCode}`);
    console.log('\n📨 Response Body:');
    console.log(JSON.stringify(data, null, 2));

    if (statusCode === 201) {
      console.log('\n✅ Success! Product created successfully');
      if (data.product) {
        console.log(`   Product ID: ${data.product.id}`);
        console.log(`   SKU: ${data.product.skuNumber}`);
        console.log(`   Price: $${data.product.price}`);
        console.log(`   File Service ID: ${data.product.publicFileServiceId}`);
      }
    } else if (statusCode === 401) {
      console.log('\n❌ Unauthorized! Check your AUTH_TOKEN');
    } else if (statusCode === 400) {
      console.log('\n❌ Bad Request! Check your product data');
    } else if (statusCode === 500) {
      console.log('\n❌ Server Error! Check the server logs');
    } else {
      console.log(`\n❌ Unexpected status code: ${statusCode}`);
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error instanceof TypeError) {
      console.error('   Make sure the server is running at', BASE_URL);
    }
  }
}

testAddProductV2();
