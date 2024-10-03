const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const url = require('url');

const app = express();
const PORT = 12345;

const extInfRegex = /^#EXTINF:\s*([\d.-]+),/;  // 匹配 #EXTINF 标签


function createDirectory(dirPath) {
    return new Promise((resolve, reject) => {
        fs.access(dirPath, fs.constants.F_OK, (err) => {
            if (err) {
                // 目录不存在，创建目录
                fs.mkdir(dirPath, {recursive: true}, (err) => {
                    if (err) {
                        console.error(`Error creating directory: ${err.message}`);
                        reject(err);
                        return;
                    }
                    resolve();
                });
            } else {
                // 目录已存在
                resolve();
            }
        });
    });
}

async function processLink(link) {
    // 解析 URL
    const parsedUrl = url.parse(link);

    // 获取基础路径
    // const basePath = `${parsedUrl.host}${parsedUrl.pathname}`;
    const dirPath = path.join(__dirname, parsedUrl.host, parsedUrl.pathname.replace(/\/[^\/]*$/, '')); // 去掉文件名部分
    const fileName = path.basename(parsedUrl.pathname); // 获取文件名
    if (fileName.endsWith("ts")) {
        //提取倒数第二级目录
        const parts = parsedUrl.pathname.split('/');
        // const penultimateDir = parts.slice(-2, -1).join('/'); // 倒数第二级目录
        const penultimateDir = parts.slice(1, -2).join('/');
        const fileName = path.basename(parsedUrl.pathname); // 获取文件名
        // 使用倒数第二级目录作为保存目录
        const dirPath = path.join(__dirname, parsedUrl.hostname, penultimateDir);

        await createDirectory(dirPath);

        return {dirPath, fileName};
    } else {
        await createDirectory(dirPath);
        return {dirPath, fileName};
    }
}


// 提取 .ts 相关标签的辅助函数
function extractTsSegments(data) {
    const lines = data.split('\n');  // 按行分割
    const tsSegments = {};  // 用于存储链接和时长标签的对象

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // 检查当前行是否为 .ts 标签
        if (tsRegex.test(line)) {
            // 确保前一行是 #EXTINF 标签
            if (i > 0 && extInfRegex.test(lines[i - 1])) {
                const extInfTag = lines[i - 1].trim();  // 获取 #EXTINF 标签
                // const tsLink = line.split('?')[0]; // 去掉可能的查询参数

                // 将链接作为键，#EXTINF 标签作为值存储在对象中
                tsSegments[line] = extInfTag; // 直接使用标签内容
            }
        }
    }

    return tsSegments; // 返回包含链接和 #EXTINF 标签的对象
}

let isWriting = false;
async function appendM3U8File(filePath, fileData) {
    const waitUntilUnlocked = async () => {
        while (isWriting) {
            await new Promise(resolve => setTimeout(resolve, 10)); // 等待 100ms
        }
        isWriting = true; // 加锁
        try {
            // 读取现有文件内容
            const existingData = await fs.promises.readFile(filePath, 'utf-8'); // 读取文件内容

            // 确保新传入的数据也是字符串
            const newFileData = fileData.toString(); // 如果 fileData 是 Buffer，转换为字符串

            //old ts
            const oldsTags = extractTsSegments(existingData);  // 提取old的 .ts 标签

            // 提取新的 .ts 标签部分
            const newTsTags = extractTsSegments(newFileData);  // 提取新的 .ts 标签

            // 遍历 oldTags 中的每一个 key
            for (const oldKey in oldsTags) {
                // 如果 oldKey 在 newTsTags 中存在，则删除 newTsTags 中的对应项
                if (newTsTags.hasOwnProperty(oldKey)) {
                    delete newTsTags[oldKey]; // 删除重复项
                }
            }

            // 生成将要追加的内容
            const newContent = Object.entries(newTsTags)
                .map(([key, value]) => `${value.trim()}\n${key}`)  // 生成格式为 "value\nkey"
                .join('\n');  // 每对之间换行
            let result = newContent.trim();
            if (result.trim().length === 0) {
            } else {
                // 追加文本
                await fs.promises.appendFile(filePath, newContent+"\n", 'utf-8');
            }
        } catch (error) {
            console.error('Error during file operation:', error);
            throw error; // 抛出错误，供调用者处理
        } finally {
            isWriting = false;
        }
    };
    await waitUntilUnlocked(); // 等待直到解锁
}

// Middleware to parse incoming raw data
app.use(bodyParser.raw({type: 'application/octet-stream', limit: '150mb'}));
const tsRegex = /\.ts(\?.*)?$/;  // 匹配以 .ts 结尾的行，忽略可能的参数
// Endpoint to receive the file
app.post('/save', async (req, res) => {
    const fileData = req.body;  // The binary data from the request
    const url = req.headers['x-filename-url'];  // Extract file name from header
    if (!url) {
        res.status(200).send();
        return;
    }

    // 使用示例
    try {
        const {dirPath, fileName} = await processLink(url); // 获取目录和文件名
        // 保存文件到指定目录
        const filePath = path.join(dirPath, fileName);

        // 检查文件是否已存在
        if (fileName.endsWith('.m3u8')) {
            if (fs.existsSync(filePath)) {
                await appendM3U8File(filePath, fileData);
            } else {
                console.log("新建m3u8.", filePath);
                // 如果文件不存在，直接保存文件
                const newFileData = fileData.toString();  // 确保传入的数据为字符串
                await fs.promises.writeFile(filePath, newFileData, 'utf-8');
            }
        } else {
            // 检查文件是否已存在
            if (fs.existsSync(filePath)) {
                res.status(200).send(`File already exists, skipping: ${fileName}`);
                return; // 文件已存在，跳过
            }

            // 保存文件到指定目录
            await fs.promises.writeFile(filePath, fileData, 'binary'); // 写入文件数据
            console.log(`File saved successfully: ${fileName}`);
        }

        res.status(200).send(`File saved successfully: ${fileName}`);
    } catch (error) {
        console.error(`Error during processing: ${error.message}`);
        res.status(500).send(`Error saving file: ${error.message}`);
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});


