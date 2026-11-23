# Converter Studio nodes for Node-RED

Node-RED nodes for [Converter Studio](https://converter.studio), a file conversion service: video, audio, images, PDFs, documents, e-books, subtitles, data and archives, 67 formats in all. The **convert** node sends a file from your flow (a Buffer, a file on the Node-RED machine, or a link) to the [Converter Studio API](https://converter.studio/developers), waits for the result and puts the converted file back into the message.

Examples of what it does: iPhone HEIC photos to JPG, Word, Excel and PowerPoint files to PDF, scanned PDFs to text or Word (OCR), PDFs to smaller PDFs, MOV videos to MP4, videos to MP3 or GIF, images to WebP or AVIF of a given size, e-books between EPUB, MOBI and PDF, CSV to Excel or JSON.

## Install

In the Node-RED editor: **Menu > Manage palette > Install**, search for `converter-studio`, and install `@converterstudio/node-red-converter-studio`.

Or in your Node-RED user directory (usually `~/.node-red`), then restart Node-RED:

```sh
npm install @converterstudio/node-red-converter-studio
```

## Nodes

The nodes are in the **Converter Studio** category of the palette.

| Node           | What it does                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **convert**    | Converts a file to another format: a Buffer, a file path or a link. Waits for the result and sends the converted file on. |
| **conversion** | Gets a conversion by its ID (its status, and the file once it is done), or confirms a conversion that was quoted.         |
| **account**    | Reads the account of the API key: its plan, the credits left and the largest file it can convert.                         |
| **formats**    | Lists the formats and what each converts to, or only what one format converts to.                                         |

Each node has its own help in the editor's help sidebar.

## Set up

You need a Converter Studio account and an API key:

1. Sign in at [converter.studio](https://converter.studio). A free account works; it gets 13 credits a day.
2. Open your [account page](https://converter.studio/account#api-keys) and create an API key. Keys start with `cvs_live_` and are shown once.
3. In Node-RED, add a convert node, open it, and add a **Converter Studio** config node next to **Account**. Paste the key into **API key**. Leave **Base URL** as it is (`https://converter.studio/api`); change it only to use another Converter Studio server.

Node-RED keeps the key with its credentials, apart from the flow, so exporting a flow leaves it out. The account node is a quick way to check the key.

Every conversion uses the account's credits, the same as on the website. Most files cost 1 credit. Audio and video are priced once Converter Studio has measured them: by their length, and video also by its frame size and the format made (WebM costs several times as much as MP4). The [pricing page](https://converter.studio/pricing) has a price estimator.

## Usage

### Convert a file

The convert node reads the file from `msg.payload` (or another property, set in **File**):

- a **Buffer** with the file's bytes, for example from a **read file** node set to output _a single Buffer object_, an **http request** node set to return _a binary buffer_, or an e-mail attachment. Its name comes from `msg.filename` (**File name**); a path counts only by its last part, so the `msg.filename` of a read file node works as it is. The name tells Converter Studio the file's format.
- the **path** of a file on the Node-RED machine, absolute or relative to Node-RED's working directory. The node reads it itself, in parts for large files, and names it by the path's last part.
- an **`https://` link**. Converter Studio downloads the file itself: a direct link to a file, or a Google Drive, Dropbox or OneDrive share link that anyone with the link can open.

**Convert to** is the target format: `pdf`, `jpg`, `png`, `webp`, `avif`, `mp4`, `mp3`, `docx`, `txt` and so on. It can also come from the message (for example `msg.format`), a context or an environment variable. If a file's format can't become the target, the node says what it converts to instead, before anything is charged. The **formats** node lists them all.

What comes out:

| Property          | What it holds                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `msg.payload`     | The converted file as a Buffer (default), or its download link, or the conversion, as **Output** says.                                                  |
| `msg.filename`    | The converted file's name, for example `report.pdf`. A **write file** node can use it, for example with the JSONata filename `"/data/out/" & filename`. |
| `msg.contentType` | Its media type, for example `application/pdf` (Buffer output only).                                                                                     |
| `msg.conversion`  | The conversion: `id`, `status`, `from`, `to`, `credits`, `outputName`, `outputSize`, `downloadUrl`, `expiresAt` and `error`.                            |

The other properties of the message stay as they were. The download link works for anyone who has it until `expiresAt`: results are kept for 6 hours.

### Price limit and quotes

**Max credits** (default 20) is the most a conversion may cost to start on its own. A conversion that costs more is _quoted_ and waits. **Above max** decides what the node does then:

- **Stop with an error** (default): the message stops with an error that says the price.
- **Send the quote**: the node sends the message on with `msg.conversion.status` set to `quoted` and the price in `msg.conversion.credits`. Start it later with a **conversion** node set to **Confirm**, for example after an approval.

Max credits `0` only asks for the price of every file.

### Waiting, and long conversions

With **Wait for the result** on (the default), the node waits until the conversion is done, up to **Timeout** (600 seconds). Each status check waits on Converter Studio until something changes, so a finished conversion is seen at once. A node can work on several messages at the same time; its status shows how many.

After the timeout, the message stops with an error that names the conversion, which goes on at Converter Studio: send `msg.conversion` to a **conversion** node (Get) to pick it up. Sending the message to the convert node again would start, and charge, a second conversion.

A deploy that restarts the node while it waits stops the wait with a warning that names the conversion; the conversion goes on.

With **Wait for the result** off, the node sends the conversion on at once. If your Node-RED can be reached from the internet over `https://`, a **Callback URL** lets Converter Studio tell a flow when the conversion ends, so that no message has to wait:

1. A flow starts with an **http in** node (method POST, for example URL `/converter-studio/callback`) wired to an **http response** node (status 200) and to a **conversion** node: Get, Conversion `msg.payload.conversion.id`, **Wait until it is finished** off. Then a **switch** node on `msg.conversion.status`: `done` comes with the file.
2. The convert node has **Wait for the result** off and **Callback URL** set to that address, for example `https://node-red.example.com/converter-studio/callback`.

Converter Studio sends one POST when the conversion ends (`conversion.done`, `conversion.failed` or `conversion.canceled`), and one before that if it waits for a go-ahead because it costs more than max credits (`conversion.quoted`). The body is `{ "event", "id", "createdAt", "conversion" }`. The request isn't signed: take it as a hint that something happened, and let the conversion node get the real status and the file with your API key. Converter Studio doesn't call local or private addresses, tries again up to 5 times in about an hour if the address doesn't answer with 2xx, and sends the same `Webhook-Id` header with each try. Keep the address to yourself. The example flow _Long conversions with a callback_ is set up this way.

### Errors

Errors carry Converter Studio's own message, in plain words (for example _"This needs 3 credits and you have 1."_), and what to do next. Use a **catch** node to handle them: it gets the message in `msg.error.message`, the code in `msg.error.code` and, when there is one, the conversion in `msg.conversion` (with its `id`).

Codes come from the API (`invalidApiKey`, `notEnoughCredits`, `dailyLimit`, `fileTooLarge`, `durationTooLong`, `unsupportedConversion`, `tooManyRequests`, `remoteNotFound`, `conversionFailed`, `notFound`, `fileExpired`, `invalidRequest`…) or from the node (`quoted`, `timeout`, `noInput`, `noFormat`, `invalidOptions`, `unknownFormat`, `fileNotReadable`, `noConfig`, `network`). A conversion that fails costs nothing.

### Limits and retries

The API takes 60 requests a minute per API key for most calls. The node waits out a rate limit (HTTP 429, using `Retry-After`) and a busy server (HTTP 503) and tries again, up to three times. For hundreds of files, space the messages out with a **delay** node set to rate limit.

Every conversion request carries an `Idempotency-Key` of its own, so the node can safely send it again after a lost connection: Converter Studio answers with the same conversion and charges once.

Converter Studio checks the file size against the plan's limit before the file is sent (see the account node's `maxFileBytes`). Files up to 95 MB go up in one request; larger files go up in parts of 95 MB.

### The other nodes

The **conversion** node takes the conversion's ID from `msg.conversion.id` (or where **Conversion** says) and either gets it or confirms it. Get sends a conversion that failed on with its status and reason in `msg.conversion`, so check `msg.conversion.status`; Confirm stops the message with an error if the confirmed conversion fails. Conversions are kept for 6 hours, and only the account that started one can see it.

The **account** node sends the account in `msg.payload`: `plan`, `credits`, `allowance`, `packs`, `renewsAt`, `maxFileBytes`, `maxMediaSeconds`. The **formats** node sends the formats in `msg.payload`, each with `id`, `name`, `category`, `extensions` and `to`; **Only** limits the list to one source format. Neither costs anything, and the formats node needs no API key.

## Conversion options

**Options** in the convert node takes the settings of a conversion as a JSON object, or from the message (`msg.options`). Each option applies only to some conversions; Converter Studio skips the ones that don't apply. An option name or value it doesn't know stops the message with `invalidRequest`. Numbers such as `{"height": 720}` may be written with or without quotes.

| Name            | Values                                                                    | Applies to                                                           |
| --------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `quality`       | `high`, `balanced`, `small`                                               | Video, JPG, WebP and AVIF: how much quality to trade for size        |
| `height`        | `1080`, `720`, `480`, `360`                                               | Video: the frame's height at most (never made larger)                |
| `frameRate`     | `60`, `30`, `24`                                                          | Video: frames a second at most                                       |
| `maxSize`       | MB, 1 to 4096                                                             | MP4: the video is at most this big; its frame shrinks to fit         |
| `mute`          | `true`, `false`                                                           | Video: drop the sound                                                |
| `copyVideo`     | `true`, `false`                                                           | Video: copy the picture as it is when the target can hold it         |
| `purpose`       | `recommended`, `best`, `whatsapp`, `email`, `discord`, `social`, `custom` | MP4 (recorded with the job; send the settings it stands for too)     |
| `bitrate`       | `64`, `96`, `128`, `192`, `256`, `320`                                    | Lossy audio (MP3, AAC, M4A, OGG, Opus, WMA), and sound from a video  |
| `vbr`           | `high`, `medium`, `low`                                                   | MP3 and OGG: a variable bitrate instead of `bitrate`                 |
| `soundPurpose`  | `standard`, `music`, `voice`, `smallest`                                  | Lossy sound (recorded with the job)                                  |
| `sampleRate`    | `48000`, `44100`, `22050`                                                 | Sound: samples a second                                              |
| `channels`      | `stereo`, `mono`                                                          | Sound                                                                |
| `bitDepth`      | `16`, `24`, `32`                                                          | WAV, AIFF, FLAC (32 only for WAV)                                    |
| `trimStart`     | seconds                                                                   | Sound: start this many seconds into the original                     |
| `normalize`     | `true`, `false`                                                           | Sound: even out the loudness (EBU R128, -16 LUFS)                    |
| `fade`          | `true`, `false`                                                           | Sound: fade in and out over two seconds                              |
| `copyAudio`     | `true`, `false`                                                           | Sound from a video: keep it as it is when the target holds its codec |
| `width`         | `2560`, `1920`, `1280`, `800`                                             | Images: the width at most                                            |
| `longSide`      | `2560`, `1920`, `1280`, `800`                                             | Images: the longer side at most                                      |
| `scale`         | `75`, `50`, `25`                                                          | Images: this percentage of the size                                  |
| `resizeWidth`   | pixels, 1 to 10000                                                        | Images: the width; alone, it keeps the proportions                   |
| `resizeHeight`  | pixels, 1 to 10000                                                        | Images: the height; alone, it keeps the proportions                  |
| `fit`           | `inside`, `cover`                                                         | Images with both sizes: fit inside them, or fill them and crop       |
| `maxKb`         | KB, 5 to 100000                                                           | JPG, WebP and AVIF: the file is at most this many kilobytes          |
| `lossless`      | `true`, `false`                                                           | WebP and AVIF: lossless (logos, screenshots)                         |
| `background`    | `#rrggbb`                                                                 | JPG and BMP: the color behind what was transparent                   |
| `keepMetadata`  | `true`, `false`                                                           | Images: keep the photo's details (EXIF), removed by default          |
| `keepLocation`  | `true`, `false`                                                           | Images, with `keepMetadata`: keep the GPS location too               |
| `rotate`        | `90`, `180`, `270`                                                        | Images: turn clockwise                                               |
| `flip`          | `true`, `false`                                                           | Images: mirror left to right                                         |
| `iconSize`      | `favicon`, `256`, `128`, `64`, `48`, `32`, `16`                           | ICO                                                                  |
| `svgScale`      | `1`, `2`, `4`                                                             | SVG to a picture: times its own size                                 |
| `gifWidth`      | `320`, `480`, `640`                                                       | GIF from a video: its width                                          |
| `fps`           | `10`, `12`, `15`                                                          | GIF from a video: frames a second                                    |
| `start`         | seconds                                                                   | GIF from a video: where in the video it starts                       |
| `dpi`           | `72`, `150`, `300`                                                        | PDF to images: the resolution of the pages                           |
| `compression`   | `light`, `balanced`, `strong`                                             | PDF to a smaller PDF                                                 |
| `pageRange`     | for example `"1-3, 5"`                                                    | Documents to PDF, and PDF to pictures or text: only these pages      |
| `pdfA`          | `true`, `false`                                                           | Documents to PDF: an archival PDF/A                                  |
| `sheetsOnePage` | `true`, `false`                                                           | Spreadsheets to PDF: each sheet on one page                          |
| `ocr`           | `true`, `false`                                                           | PDF to Word or text: recognize the text of scanned pages             |
| `ocrLanguage`   | `auto`, `en`, `de`, `fr`, `es`, `it`, `pt`, `nl`, `pl`, `tr`, `ru`, …     | Text recognition: the language of the text                           |
| `csvDelimiter`  | `comma`, `semicolon`, `tab`                                               | CSV read or written                                                  |
| `csvEncoding`   | `utf8`, `utf8bom`, `windows1254`                                          | CSV written                                                          |
| `sheet`         | 1 to 255                                                                  | Spreadsheet to CSV: which sheet                                      |
| `header`        | `true`, `false`                                                           | CSV to JSON, XML or YAML: the first row holds the field names        |
| `nested`        | `columns`, `json`                                                         | JSON, XML, YAML to CSV or Excel: what happens to nested data         |
| `jsonIndent`    | `2`, `4`, `compact`                                                       | JSON written                                                         |
| `password`      | text                                                                      | A locked ZIP, 7Z or RAR: used for this conversion only, never stored |
| `archiveLevel`  | `fast`, `normal`, `smallest`                                              | ZIP, 7Z and TAR.GZ written                                           |
| `ebookReader`   | `generic`, `kindle`, `kobo`, `tablet`                                     | EPUB, MOBI, AZW3 written                                             |
| `bookTitle`     | text                                                                      | E-books: the title the book shows                                    |
| `bookAuthor`    | text                                                                      | E-books: the author the book shows                                   |
| `paperSize`     | `a4`, `a5`, `letter`, `phone`                                             | E-books to PDF                                                       |
| `textSize`      | `small`, `medium`, `large`                                                | E-books to PDF                                                       |
| `margins`       | `narrow`, `normal`, `wide`                                                | E-books to PDF                                                       |
| `tocPage`       | `true`, `false`                                                           | E-books to PDF: a contents page                                      |
| `slideLayout`   | `slides`, `notes`, `handout`                                              | Slides to PDF                                                        |
| `handoutSlides` | `2`, `3`, `4`, `6`, `9`                                                   | Slides to PDF as handouts                                            |
| `hiddenSlides`  | `true`, `false`                                                           | Slides to PDF: hidden slides too                                     |
| `subtitleShift` | seconds, -3600 to 3600                                                    | Subtitles: every line later (or earlier)                             |
| `subtitleFps`   | `23.976-25`, `25-23.976`, `24-25`, `25-24`                                | Subtitles: re-timed for another frame rate                           |
| `fontSubset`    | `all`, `latin`, `latinCyrillic`                                           | WOFF and WOFF2                                                       |

For example `{"quality": "small", "height": 720}` for a smaller MP4, `{"maxKb": 300}` for a JPG of at most 300 KB, or `{"ocr": true, "ocrLanguage": "en"}` for a scanned PDF to Word. The [API documentation](https://converter.studio/developers) has the details.

## Example flows

The package comes with example flows: in the editor, **Menu > Import > Examples > @converterstudio/node-red-converter-studio**. Each starts with a comment node that says what to change.

- **Convert a file to PDF**: read file → convert → write file, with a catch node for errors.
- **Convert a link to WebP**: Converter Studio downloads a picture from a link; the node sends the download link of the result on.
- **Approve an expensive conversion**: get the price of a video conversion first (max credits 0), then start it with a conversion node set to Confirm.
- **Long conversions with a callback**: start without waiting, and let Converter Studio call an http in node when the conversion ends.
- **Check the account and the formats**: the credits left, and what HEIC converts to.

## Compatibility

Node-RED 4.0 or later, on Node.js 22 or later. Tested with Node-RED 5.0.10 on Node.js 24 and Node-RED 4.1.18 on Node.js 22, installed from the packed package through the palette manager: every node, every example flow and the callback recipe, against a Converter Studio test server. The package has no runtime dependencies.

## Privacy

The nodes send the files you give them to Converter Studio, only to be converted. Uploads are deleted once converted, results after 6 hours. The convert node's editor also asks Converter Studio for the list of formats, with no key and no file. See the [privacy policy](https://converter.studio/privacy) and the [terms](https://converter.studio/terms).

## Development

```sh
npm ci
npm run lint
npm test             # Node-RED's test helper and a local stand-in for the API: no network, no API key
npm run validate     # node-red-dev, the Flow Library's scorecard check (needs the network)
```

Releases are published to npm by this repository's GitHub Actions workflow (`.github/workflows/publish.yml`) when a version tag is pushed, with an [npm provenance statement](https://docs.npmjs.com/generating-provenance-statements): the package page on npm shows the commit and the workflow each version was built from.

## Support

- [Converter Studio API and MCP server](https://converter.studio/developers)
- E-mail [support@converter.studio](mailto:support@converter.studio), or [open an issue](https://github.com/tariksucu/node-red-converter-studio/issues)

## License

[MIT](https://github.com/tariksucu/node-red-converter-studio/blob/main/LICENSE), © Converter Studio
