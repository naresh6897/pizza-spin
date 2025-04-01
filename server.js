const express = require('express');
const bodyParser = require('body-parser');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000; // Dynamic port for hosting platforms
const EXCEL_FILE = path.join(__dirname, 'customers.xlsx');

// Middleware
app.use(bodyParser.json());
app.use(express.static(__dirname)); // Serve static files (HTML, CSS, JS)

// Initialize Excel file if it doesn’t exist
async function initializeExcel() {
  try {
    const exists = await fs.access(EXCEL_FILE).then(() => true).catch(() => false);
    if (!exists) {
      console.log('Creating new Excel file at:', EXCEL_FILE);
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Customers');
      sheet.columns = [
        { header: 'Name', key: 'name', width: 20 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Phone', key: 'phone', width: 15 },
        { header: 'Offer', key: 'offer', width: 20 },
      ];
      await workbook.xlsx.writeFile(EXCEL_FILE);
      console.log('Excel file created successfully');
    } else {
      console.log('Excel file already exists at:', EXCEL_FILE);
    }
  } catch (error) {
    console.error('Failed to initialize Excel:', error);
    throw error;
  }
}

// Retry mechanism for writing to Excel
async function writeWithRetry(workbook, retries = 3, delay = 500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Attempt ${attempt}: Writing to Excel file...`);
      await workbook.xlsx.writeFile(EXCEL_FILE);
      console.log('Write operation completed');
      return true;
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error.message);
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Handle initial form submission
app.post('/submit', async (req, res) => {
  const { name, email, phone } = req.body;

  console.log('Received initial submission:', { name, email, phone });

  if (!name || !email || !phone) {
    console.log('Validation failed: Missing required fields');
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  if (!/^\d{10}$/.test(phone)) {
    console.log('Validation failed: Invalid phone number');
    return res.status(400).json({ success: false, error: 'Invalid phone number (10 digits required)' });
  }

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(EXCEL_FILE);
    const sheet = workbook.getWorksheet('Customers');
    const newRow = sheet.addRow([name, email, phone, '']);
    newRow.commit();

    await writeWithRetry(workbook);

 Celebratingconsole.log('Data saved to Excel, sending success response');
    res.status(200).json({ success: true, name });
  } catch (error) {
    console.error('Failed to save to Excel:', error);
    res.status(500).json({ success: false, error: 'Failed to save data' });
  }
});

// Handle offer submission after spinning
app.post('/submit-offer', async (req, res) => {
  const { name, offer } = req.body;

  console.log('Received offer submission:', { name, offer });

  if (!name || !offer) {
    console.log('Validation failed: Missing name or offer');
    return res.status(400).json({ success: false, error: 'Missing name or offer' });
  }

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(EXCEL_FILE);
    const sheet = workbook.getWorksheet('Customers');

    let rowFound = false;
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1 && row.getCell(1).value === name) {
        row.getCell(4).value = offer;
        row.commit();
        rowFound = true;
      }
    });

    if (!rowFound) {
      const newRow = sheet.addRow([name, '', '', offer]);
      newRow.commit();
    }

    await writeWithRetry(workbook);

    console.log('Offer saved to Excel, sending success response');
    res.status(200).json({ success: true, name, offer });
  } catch (error) {
    console.error('Failed to save offer to Excel:', error);
    res.status(500).json({ success: false, error: 'Failed to save offer' });
  }
});

// Endpoint to download customers.xlsx
app.get('/download', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'customers.xlsx');
    await fs.access(filePath); // Check if file exists
    res.download(filePath, 'customers.xlsx', (err) => {
      if (err) {
        console.error('Error sending file:', err);
        res.status(500).send('Error downloading file');
      }
    });
  } catch (error) {
    console.error('File not found or inaccessible:', error);
    res.status(404).send('No customer data available yet');
  }
});

// Start server and initialize Excel
(async () => {
  await initializeExcel();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
})();