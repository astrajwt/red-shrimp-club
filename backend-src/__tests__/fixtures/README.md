# Test Fixtures

Test fixtures for Phase 2 testing suite.

## Images

### test-image.png
- Format: PNG
- Size: ~10KB
- MIME: image/png
- Purpose: Valid image upload test
- Metadata: Contains minimal EXIF data

### test-image.jpg
- Format: JPEG
- Size: ~15KB
- MIME: image/jpeg
- Purpose: Valid JPEG upload test
- Metadata: Clean EXIF (no private data)

### oversized-image.png
- Format: PNG
- Size: ~15MB
- Purpose: Test oversized file rejection (>10MB limit)

### image-with-script.png
- Format: PNG (actually contains embedded script)
- Purpose: Test malicious content detection
- Security: Should be rejected

### double-extension.jpg.exe
- Type: Executable disguised as image
- Purpose: Test double-extension bypass prevention
- Security: Should be rejected

## PDFs

### valid-document.pdf
- Format: PDF
- Size: ~50KB
- Content: Simple text document
- Purpose: Valid PDF upload test
- Security: Clean, no embedded content

### pdf-with-embedded-script.pdf
- Format: PDF with JavaScript
- Purpose: Test PDF script detection
- Security: Should be sandboxed/rejected

### corrupted.pdf
- Format: Invalid PDF
- Purpose: Test PDF validation
- Expected: Reject with 400 error

### oversized-document.pdf
- Size: ~60MB
- Purpose: Test oversized PDF rejection (>50MB limit)

## Malware Simulation

### executable.exe
- Type: Executable binary
- Purpose: Test executable rejection
- Security: Should be rejected

### script.vbs
- Type: VBScript
- Purpose: Test script rejection
- Security: Should be rejected

### file-with-null-bytes.pdf
- Content: PDF data with embedded null bytes
- Purpose: Test null-byte injection prevention
- Security: Should be rejected

## Configuration

All fixtures are stored in `__tests__/fixtures/` and should be:
1. Version controlled (for reproducibility)
2. Scanned for actual malware (even though they're test fixtures)
3. Used only in isolated test environments
4. Cleaned up after tests

## Usage in Tests

```typescript
import fs from 'fs'
import path from 'path'

const fixturePath = path.join(__dirname, 'fixtures', 'test-image.png')
const fileBuffer = fs.readFileSync(fixturePath)

const res = await request(app)
  .post('/api/files/upload')
  .attach('file', fileBuffer, 'test-image.png')
```

## Adding New Fixtures

1. Place file in `__tests__/fixtures/`
2. Document here with: name, format, size, purpose, security notes
3. Update test suite to use fixture
4. Run security scan on fixture before committing
