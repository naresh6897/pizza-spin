const express = require('express');
const bodyParser = require('body-parser');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs').promises;
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const LOCAL_EXCEL_FILE = path.join(__dirname, 'customers.xlsx');
const GOOGLE_DRIVE_FOLDER_ID = '1IukhF0WohOBlbOtJCX-ltxgPs-Gi3EpL';

// Flag to prevent concurrent file access
let isFileWriting = false;

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

app.use(bodyParser.json());
app.use(express.static(__dirname));

async function initializeExcel() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Customers', {
    properties: { defaultColWidth: 20 }
  });
  sheet.columns = [
    { header: 'Name', key: 'name', width: 20 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Phone', key: 'phone', width: 15 },
  ];
  return workbook;
}

async function loadLocalExcel() {
  let workbook;
  try {
    // Check if the file exists
    const fileExists = await fs.access(LOCAL_EXCEL_FILE).then(() => true).catch(() => false);
    if (!fileExists) {
      throw new Error('Excel file does not exist. Creating a new one.');
    }

    // Check if the file is empty or too small to be a valid Excel file
    const fileStats = await fs.stat(LOCAL_EXCEL_FILE);
    if (fileStats.size < 1000) { // Arbitrary small size to indicate an invalid file
      throw new Error('Excel file is too small or empty. Recreating the file.');
    }

    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(LOCAL_EXCEL_FILE);
    console.log('Loaded local Excel file:', LOCAL_EXCEL_FILE);

    const sheet = workbook.getWorksheet('Customers');
    if (!sheet) {
      throw new Error('Worksheet "Customers" not found in the Excel file.');
    }

    // Check if the worksheet has any rows (including header)
    if (sheet.rowCount === 0) {
      throw new Error('Worksheet is empty. Recreating the file.');
    }

    // Check column count
    if (sheet.columnCount > 16384) {
      throw new Error('Excel file has too many columns. Recreating the file.');
    }

    // Validate column structure
    const expectedColumns = ['Name', 'Email', 'Phone'];
    const actualColumns = sheet.getRow(1).values?.slice(1) || [];
    if (!expectedColumns.every((col, idx) => actualColumns[idx] === col)) {
      console.log('Invalid column structure detected:', actualColumns);
      throw new Error('Invalid column structure.');
    }
  } catch (error) {
    console.log('Error loading Excel file, initializing a new one:', error.message);
    workbook = await initializeExcel();
    await workbook.xlsx.writeFile(LOCAL_EXCEL_FILE);
    console.log('Created new Excel file:', LOCAL_EXCEL_FILE);
  }
  return workbook;
}

async function uploadToGoogleDrive() {
  if (isFileWriting) {
    console.log('File is being written, skipping Google Drive sync.');
    return;
  }

  try {
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
      body: require('fs').createReadStream(LOCAL_EXCEL_FILE),
    };

    let file;
    if (existingFiles.data.files.length > 0) {
      const fileId = existingFiles.data.files[0].id;
      file = await drive.files.update({
        fileId: fileId,
        media: media,
        fields: 'id',
      });
      console.log('Updated file in Google Drive, ID:', file.data.id);
    } else {
      file = await drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id',
      });
      console.log('Created new file in Google Drive, ID:', file.data.id);
    }
  } catch (error) {
    console.error('Failed to upload to Google Drive:', error.message);
    throw error;
  }
}

function startGoogleDriveSync() {
  setInterval(async () => {
    try {
      console.log('Starting periodic sync with Google Drive...');
      await uploadToGoogleDrive();
      console.log('Periodic sync completed.');
    } catch (error) {
      console.error('Periodic sync failed:', error.message);
    }
  }, 5 * 60 * 1000);
}

async function initializeFromGoogleDrive() {
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
        const dest = require('fs').createWriteStream(LOCAL_EXCEL_FILE);
        file.data
          .on('error', reject)
          .pipe(dest)
          .on('error', reject)
          .on('finish', resolve);
      });
      console.log('Downloaded Excel file from Google Drive to local:', LOCAL_EXCEL_FILE);
    } else {
      console.log('No Excel file found in Google Drive, initializing new one locally.');
      const workbook = await initializeExcel();
      await workbook.xlsx.writeFile(LOCAL_EXCEL_FILE);
    }
  } catch (error) {
    console.error('Error initializing from Google Drive:', error.message);
    const workbook = await initializeExcel();
    await workbook.xlsx.writeFile(LOCAL_EXCEL_FILE);
  }
}

// Check for duplicate email or phone
async function checkDuplicates(email, phone) {
  const workbook = await loadLocalExcel();
  const sheet = workbook.getWorksheet('Customers');
  let duplicateField = null;

  const normalizedEmail = email.toString().trim().toLowerCase();
  const normalizedPhone = phone.toString().trim();

  console.log('Checking for duplicates with:', { email: normalizedEmail, phone: normalizedPhone });

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) {
      const existingEmail = row.getCell('email').value?.toString().trim().toLowerCase();
      const existingPhone = row.getCell('phone').value?.toString().trim();

      console.log(`Row ${rowNumber}:`, { existingEmail, existingPhone });

      if (existingEmail === normalizedEmail) {
        duplicateField = 'email';
      } else if (existingPhone === normalizedPhone) {
        duplicateField = 'phone';
      }
    }
  });

  return duplicateField;
}

app.post('/submit', async (req, res) => {
  const { name, email, phone } = req.body;

  console.log('Received submission:', { name, email, phone });

  if (!name || !email || !phone) {
    console.log('Validation failed: Missing required fields');
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  if (!/^\d{10}$/.test(phone)) {
    console.log('Validation failed: Invalid phone number');
    return res.status(400).json({ success: false, error: 'Invalid phone number (10 digits required)' });
  }

  try {
    // Check for duplicates
    const duplicateField = await checkDuplicates(email, phone);
    if (duplicateField) {
      console.log(`Duplicate ${duplicateField} detected:`, duplicateField === 'email' ? email : phone);
      return res.status(409).json({
        success: false,
        error: `This ${duplicateField} already exists. One spin per customer!`
      });
    }

    // If no duplicates, save the data
    let workbook = await loadLocalExcel();
    let sheet = workbook.getWorksheet('Customers');

    // Add the new row
    const newRow = sheet.addRow({ name, email, phone });
    console.log('Added new row:', { name, email, phone, rowNumber: newRow.number });

    // Set the file writing flag
    isFileWriting = true;

    // Save the updated Excel file
    try {
      await workbook.xlsx.writeFile(LOCAL_EXCEL_FILE);
      console.log('Data saved to local Excel file:', LOCAL_EXCEL_FILE);
    } catch (writeError) {
      console.error('Failed to write Excel file:', writeError.message);
      // If the write fails due to an "Out of bounds" error, recreate the file
      if (writeError.message.includes('Out of bounds')) {
        console.log('Recreating Excel file due to "Out of bounds" error...');
        workbook = await initializeExcel();
        sheet = workbook.getWorksheet('Customers');
        sheet.addRow({ name, email, phone });
        await workbook.xlsx.writeFile(LOCAL_EXCEL_FILE);
        console.log('Recreated and saved new Excel file:', LOCAL_EXCEL_FILE);
      } else {
        throw writeError;
      }
    }

    // Verify the file was updated by reading it back
    const updatedWorkbook = new ExcelJS.Workbook();
    await updatedWorkbook.xlsx.readFile(LOCAL_EXCEL_FILE);
    const updatedSheet = updatedWorkbook.getWorksheet('Customers');
    const lastRow = updatedSheet.lastRow;
    console.log('Last row in Excel file after save:', {
      name: lastRow.getCell('name').value,
      email: lastRow.getCell('email').value,
      phone: lastRow.getCell('phone').value,
    });

    res.status(200).json({ success: true, name });
  } catch (error) {
    console.error('Failed to process submission:', error.message);
    // If the error is related to file loading, try one more time with a fresh file
    if (error.message.includes('Out of bounds') || error.message.includes('Invalid column structure')) {
      console.log('Retrying with a fresh Excel file...');
      let workbook = await initializeExcel();
      let sheet = workbook.getWorksheet('Customers');
      sheet.addRow({ name, email, phone });
      await workbook.xlsx.writeFile(LOCAL_EXCEL_FILE);
      console.log('Recreated and saved new Excel file after error:', LOCAL_EXCEL_FILE);

      // Verify the file was updated
      const updatedWorkbook = new ExcelJS.Workbook();
      await updatedWorkbook.xlsx.readFile(LOCAL_EXCEL_FILE);
      const updatedSheet = updatedWorkbook.getWorksheet('Customers');
      const lastRow = updatedSheet.lastRow;
      console.log('Last row in Excel file after retry:', {
        name: lastRow.getCell('name').value,
        email: lastRow.getCell('email').value,
        phone: lastRow.getCell('phone').value,
      });

      res.status(200).json({ success: true, name });
    } else {
      res.status(500).json({ success: false, error: `Failed to save data: ${error.message}` });
    }
  } finally {
    isFileWriting = false;
  }
});

app.get('/download', async (req, res) => {
  try {
    const fileExists = await fs.access(LOCAL_EXCEL_FILE).then(() => true).catch(() => false);
    if (!fileExists) {
      return res.status(404).send('No customer data available yet');
    }

    res.setHeader('Content-Disposition', 'attachment; filename=customers.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const fileStream = require('fs').createReadStream(LOCAL_EXCEL_FILE);
    fileStream.pipe(res);
  } catch (error) {
    console.error('Error downloading local file:', error.message);
    res.status(500).send('Error downloading file');
  }
});

(async () => {
  await initializeFromGoogleDrive();
  startGoogleDriveSync();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
})();