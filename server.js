const express = require('express');
const bodyParser = require('body-parser');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs').promises;
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_EXCEL_FILE = path.join(__dirname, 'temp_customers.xlsx'); // Temporary file

// Google Drive setup
const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'pizza-spin-drive-123456.json'), // Path to your service account JSON file
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });
const GOOGLE_DRIVE_FOLDER_ID = '1LtyP7jn3P5MgvLQD3fXU15M_lzqpog9o'; // Replace with your folder ID

// Middleware
app.use(bodyParser.json());
app.use(express.static(__dirname));

// Initialize Excel file (in memory, not on disk initially)
async function initializeExcel() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Customers');
  sheet.columns = [
    { header: 'Name', key: 'name', width: 20 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Phone', key: 'phone', width: 15 },
    { header: 'Offer', key: 'offer', width: 20 },
  ];
  return workbook;
}

// Upload Excel file to Google Drive
async function uploadToGoogleDrive(workbook) {
  try {
    // Save the workbook to a temporary file
    await workbook.xlsx.writeFile(TEMP_EXCEL_FILE);
    console.log('Temporary Excel file created:', TEMP_EXCEL_FILE);

    // Check if the file already exists in Google Drive
    const existingFiles = await drive.files.list({
      q: `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and name = 'customers.xlsx' and trashed = false`,
      fields: 'files(id, name)',
    });

    const fileMetadata = {
      name: 'customers.xlsx',
      parents: [GOOGLE_DRIVE_FOLDER_ID],
    };

    const media = {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: require('fs').createReadStream(TEMP_EXCEL_FILE),
    };

    let file;
    if (existingFiles.data.files.length > 0) {
      // Update existing file
      const fileId = existingFiles.data.files[0].id;
      file = await drive.files.update({
        fileId: fileId,
        media: media,
        fields: 'id',
      });
      console.log('Updated file in Google Drive, ID:', file.data.id);
    } else {
      // Create new file
      file = await drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id',
      });
      console.log('Created new file in Google Drive, ID:', file.data.id);
    }

    // Delete the temporary file
    await fs.unlink(TEMP_EXCEL_FILE);
    console.log('Temporary file deleted:', TEMP_EXCEL_FILE);
  } catch (error) {
    console.error('Failed to upload to Google Drive:', error.message);
    throw error;
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
    // Load or initialize the workbook
    let workbook;
    try {
      const response = await drive.files.list({
        q: `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and name = 'customers.xlsx' and trashed = false`,
        fields: 'files(id)',
      });

      if (response.data.files.length > 0) {
        const fileId = response.data.files[0].id;
        const file = await drive.files.get(
          { fileId, alt: 'media' },
          { responseType: 'stream' }
        );

        await new Promise((resolve, reject) => {
          const dest = require('fs').createWriteStream(TEMP_EXCEL_FILE);
          file.data
            .on('error', reject)
            .pipe(dest)
            .on('error', reject)
            .on('finish', resolve);
        });

        workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(TEMP_EXCEL_FILE);
        await fs.unlink(TEMP_EXCEL_FILE);
      } else {
        workbook = await initializeExcel();
      }
    } catch (error) {
      console.error('Error loading Excel from Drive:', error.message);
      workbook = await initializeExcel();
    }

    const sheet = workbook.getWorksheet('Customers');
    const newRow = sheet.addRow([name, email, phone, '']);
    newRow.commit();

    await uploadToGoogleDrive(workbook);

    console.log('Data saved to Google Drive, sending success response');
    res.status(200).json({ success: true, name });
  } catch (error) {
    console.error('Failed to save to Google Drive:', error.message);
    res.status(500).json({ success: false, error: `Failed to save data: ${error.message}` });
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
    // Load the workbook from Google Drive
    let workbook;
    const response = await drive.files.list({
      q: `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and name = 'customers.xlsx' and trashed = false`,
      fields: 'files(id)',
    });

    if (response.data.files.length > 0) {
      const fileId = response.data.files[0].id;
      const file = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
      );

      await new Promise((resolve, reject) => {
        const dest = require('fs').createWriteStream(TEMP_EXCEL_FILE);
        file.data
          .on('error', reject)
          .pipe(dest)
          .on('error', reject)
          .on('finish', resolve);
      });

      workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(TEMP_EXCEL_FILE);
      await fs.unlink(TEMP_EXCEL_FILE);
    } else {
      workbook = await initializeExcel();
    }

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

    await uploadToGoogleDrive(workbook);

    console.log('Offer saved to Google Drive, sending success response');
    res.status(200).json({ success: true, name, offer });
  } catch (error) {
    console.error('Failed to save offer to Google Drive:', error.message);
    res.status(500).json({ success: false, error: `Failed to save offer: ${error.message}` });
  }
});

// Endpoint to download customers.xlsx
app.get('/download', async (req, res) => {
  try {
    const response = await drive.files.list({
      q: `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and name = 'customers.xlsx' and trashed = false`,
      fields: 'files(id)',
    });

    if (response.data.files.length === 0) {
      return res.status(404).send('No customer data available yet');
    }

    const fileId = response.data.files[0].id;
    const file = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Disposition', 'attachment; filename=customers.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    file.data.pipe(res);
  } catch (error) {
    console.error('Error downloading file from Google Drive:', error.message);
    res.status(500).send('Error downloading file');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});