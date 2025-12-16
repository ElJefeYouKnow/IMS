@echo off
REM Test the IMS Item Master API

echo.
echo === Testing IMS Item Master API ===
echo.

REM Check if server is running
echo Testing if server is running on localhost:8000...
curl -s http://localhost:8000/ >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Server is not running!
    echo Please start the server first: npm start
    pause
    exit /b 1
)
echo OK: Server is running

echo.
echo Test 1: GET /api/items (should return empty array initially)
curl -s http://localhost:8000/api/items
echo.
echo.

echo Test 2: POST /api/items - Add a test item
curl -s -X POST http://localhost:8000/api/items ^
  -H "Content-Type: application/json" ^
  -d "{\"code\":\"TEST-001\",\"name\":\"Test Item\",\"category\":\"Electronics\",\"unitPrice\":99.99}"
echo.
echo.

echo Test 3: GET /api/items - List items (should show the item we just added)
curl -s http://localhost:8000/api/items
echo.
echo.

echo Test 4: DELETE /api/items/TEST-001 - Delete the test item
curl -s -X DELETE http://localhost:8000/api/items/TEST-001
echo.
echo.

echo Test 5: GET /api/items - Verify item was deleted
curl -s http://localhost:8000/api/items
echo.
echo.

echo === All tests completed ===
pause
