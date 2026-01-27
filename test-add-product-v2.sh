#!/bin/bash

# Test script for V2 Add Product endpoint
# This script tests the /v2/add-product endpoint

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
BASE_URL="http://localhost:8787"
ENDPOINT="/v2/add-product"

# You'll need to set these from your environment or update them manually
AUTH_TOKEN=${AUTH_TOKEN:-"your_jwt_token_here"}

# Sample product data
read -r -d '' PRODUCT_DATA << 'EOF' || true
{
  "name": "Test Product V2",
  "description": "A test 3D printed product using V2 API",
  "image": "https://example.com/image.jpg",
  "imageGallery": ["https://example.com/image1.jpg", "https://example.com/image2.jpg"],
  "stl": "https://your-r2-bucket.r2.dev/test-model.stl",
  "filamentType": "PLA",
  "color": "Black",
  "price": 0.15,
  "categoryId": 1
}
EOF

echo -e "${YELLOW}======================================${NC}"
echo -e "${YELLOW}V2 Add Product Endpoint Test${NC}"
echo -e "${YELLOW}======================================${NC}"
echo ""
echo -e "${YELLOW}Endpoint:${NC} POST $BASE_URL$ENDPOINT"
echo -e "${YELLOW}Auth Token:${NC} ${AUTH_TOKEN:0:20}..."
echo ""
echo -e "${YELLOW}Product Data:${NC}"
echo "$PRODUCT_DATA" | jq '.'
echo ""
echo -e "${YELLOW}Making request...${NC}"
echo ""

# Make the curl request
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "$BASE_URL$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d "$PRODUCT_DATA")

# Extract HTTP code (last line)
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
# Extract response body (everything except last line)
BODY=$(echo "$RESPONSE" | sed '$d')

echo -e "${YELLOW}Response Status Code:${NC} $HTTP_CODE"
echo ""
echo -e "${YELLOW}Response Body:${NC}"
echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"

echo ""
if [ "$HTTP_CODE" -eq 201 ]; then
  echo -e "${GREEN}✓ Success! Product created successfully${NC}"
elif [ "$HTTP_CODE" -eq 401 ]; then
  echo -e "${RED}✗ Unauthorized! Check your AUTH_TOKEN${NC}"
elif [ "$HTTP_CODE" -eq 400 ]; then
  echo -e "${RED}✗ Bad Request! Check your product data${NC}"
elif [ "$HTTP_CODE" -eq 500 ]; then
  echo -e "${RED}✗ Server Error! Check the server logs${NC}"
else
  echo -e "${RED}✗ Unexpected status code: $HTTP_CODE${NC}"
fi

echo ""
