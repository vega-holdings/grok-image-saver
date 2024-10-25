// ==UserScript==
// @name         Grok Image Saver
// @namespace    http://tampermonkey.net/
// @version      0.6
// @description  Save images from Grok AI conversations on X (Twitter) with metadata
// @author       Your name
// @match        https://x.com/i/grok*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @require      https://cdnjs.cloudflare.com/ajax/libs/piexifjs/1.0.6/piexif.js
// ==/UserScript==

(function() {
    'use strict';

    const DEBUG = true;
    function log(...args) {
        if (DEBUG) console.log('[Grok Saver]', ...args);
    }

    // Track conversation counters and processed images
    let conversationCounters = GM_getValue('conversationCounters', {});
    const processedImages = new Set();
    let currentConversationId = null;
    let isProcessing = false;

    function getCurrentConversationId() {
        const url = new URL(window.location.href);
        return url.searchParams.get('conversation') || 'unknown';
    }

    function getNextCounter(conversationId) {
        if (!conversationCounters[conversationId]) {
            conversationCounters[conversationId] = 1;
        }
        const counter = conversationCounters[conversationId];
        conversationCounters[conversationId]++;
        GM_setValue('conversationCounters', conversationCounters);
        return counter;
    }

    function getUniqueFilename(conversationId) {
        const counter = getNextCounter(conversationId);
        return `grok_${conversationId}_${counter.toString().padStart(3, '0')}.jpg`;
    }

    function extractPrompt(imageElement) {
        try {
            let container = imageElement;
            let maxDepth = 10;
            let promptText = null;

            while (maxDepth > 0 && container && !promptText) {
                // Try Grok's response format first
                const grokResponses = container.querySelectorAll('div[dir="ltr"]');
                for (const element of grokResponses) {
                    const text = element.textContent.trim();
                    if (text && text.includes("I generated an image with the prompt:")) {
                        const promptMatch = text.match(/I generated an image with the prompt: [''](.+?)['']$/);
                        if (promptMatch) {
                            promptText = promptMatch[1];
                            log('Found Grok response prompt:', promptText);
                            break;
                        }
                    }
                }

                // Try direct user prompt if no Grok response found
                if (!promptText) {
                    const directPrompts = container.querySelectorAll('.css-1jxf684.r-bcqeeo.r-1ttztb7.r-qvutc0.r-poiln3');
                    for (const element of directPrompts) {
                        const text = element.textContent.trim();
                        if (text && text.length > 10 && !text.includes("I generated")) {
                            promptText = text;
                            log('Found direct prompt:', promptText);
                            break;
                        }
                    }
                }

                container = container.parentElement;
                maxDepth--;
            }

            return promptText || 'No prompt available';
        } catch (error) {
            log('Error extracting prompt:', error);
            return 'Error extracting prompt';
        }
    }

    function saveImage(imageUrl, prompt, retryCount = 0) {
        const MAX_RETRIES = 3;
        const conversationId = getCurrentConversationId();

        if (processedImages.has(imageUrl)) {
            log('Image already processed:', imageUrl);
            return;
        }

        log('Attempting to save image:', imageUrl);
        log('With prompt:', prompt);
        log('Conversation ID:', conversationId);

        GM_xmlhttpRequest({
            method: "GET",
            url: imageUrl,
            responseType: "blob",
            onload: function(response) {
                if (response.status !== 200) {
                    log('Error response status:', response.status);
                    if (retryCount < MAX_RETRIES) {
                        setTimeout(() => saveImage(imageUrl, prompt, retryCount + 1), 1000);
                    }
                    return;
                }

                const blob = response.response;
                const reader = new FileReader();

                reader.onloadend = function() {
                    const base64data = reader.result;
                    const img = new Image();

                    img.onload = function() {
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        ctx.drawImage(img, 0, 0);

                        try {
                            const exif = piexif.dump({
                                "0th": {
                                    [piexif.ImageIFD.ImageDescription]: prompt,
                                    [piexif.ImageIFD.Software]: "Grok AI",
                                    [piexif.ImageIFD.DateTime]: new Date().toISOString(),
                                    [piexif.ImageIFD.DocumentName]: `Conversation: ${conversationId}`
                                }
                            });

                            const exifStr = piexif.insert(exif, canvas.toDataURL("image/jpeg", 0.95));
                            const filename = getUniqueFilename(conversationId);

                            GM_download({
                                url: exifStr,
                                name: filename,
                                saveAs: false,
                                onload: () => {
                                    log(`Successfully saved: ${filename}`);
                                    processedImages.add(imageUrl);
                                    updateStatusPanel(`Last saved: ${filename}`);
                                },
                                onerror: (error) => {
                                    log(`Error saving ${filename}:`, error);
                                    if (retryCount < MAX_RETRIES) {
                                        setTimeout(() => saveImage(imageUrl, prompt, retryCount + 1), 1000);
                                    }
                                }
                            });
                        } catch (error) {
                            log('Error in EXIF/save:', error);
                            if (retryCount < MAX_RETRIES) {
                                setTimeout(() => saveImage(imageUrl, prompt, retryCount + 1), 1000);
                            }
                        }
                    };

                    img.onerror = function() {
                        log('Error loading image');
                        if (retryCount < MAX_RETRIES) {
                            setTimeout(() => saveImage(imageUrl, prompt, retryCount + 1), 1000);
                        }
                    };

                    img.src = base64data;
                };

                reader.readAsDataURL(blob);
            },
            onerror: (error) => {
                log('Error downloading image:', error);
                if (retryCount < MAX_RETRIES) {
                    setTimeout(() => saveImage(imageUrl, prompt, retryCount + 1), 1000);
                }
            }
        });
    }

    function scanForExistingImages() {
        if (isProcessing) return;
        isProcessing = true;

        log('Scanning for existing images...');
        const images = document.querySelectorAll('img[src^="blob:"]');
        images.forEach((img) => {
            const prompt = extractPrompt(img);
            if (img.src) {
                saveImage(img.src, prompt);
            }
        });

        isProcessing = false;
    }

    let statusPanel;
    function addControlPanel() {
        statusPanel = document.createElement('div');
        statusPanel.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 10px;
            border-radius: 8px;
            z-index: 10000;
            font-family: Arial, sans-serif;
            min-width: 200px;
        `;
        updateStatusPanelContent();
        document.body.appendChild(statusPanel);

        document.getElementById('rescanImages')?.addEventListener('click', () => {
            updateStatusPanel('Rescanning...');
            scanForExistingImages();
        });
    }

    function updateStatusPanelContent() {
        const conversationId = getCurrentConversationId();
        const counter = conversationCounters[conversationId] || 0;

        statusPanel.innerHTML = `
            <div style="margin-bottom: 5px">Grok Image Saver Active</div>
            <div style="font-size: 12px">Conversation: ${conversationId}</div>
            <div id="grokSaverStatus" style="font-size: 12px">Images in conversation: ${counter}</div>
            <button id="rescanImages" style="margin-top: 5px; padding: 3px 8px; font-size: 12px;">Rescan Images</button>
        `;
    }

    function updateStatusPanel(message) {
        const statusElement = document.getElementById('grokSaverStatus');
        if (statusElement) {
            statusElement.textContent = message;
        }
        updateStatusPanelContent();
    }

    function observeGrokConversation() {
        const observer = new MutationObserver((mutations) => {
            if (isProcessing) return;
            isProcessing = true;

            try {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach((node) => {
                            if (node.nodeType === Node.ELEMENT_NODE) {
                                const images = node.querySelectorAll('img[src^="blob:"]');
                                images.forEach((img) => {
                                    const prompt = extractPrompt(img);
                                    if (img.src) {
                                        saveImage(img.src, prompt);
                                    }
                                });
                            }
                        });
                    }
                });
            } finally {
                isProcessing = false;
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        log('Observer started');
    }

    // Initialize
    function init() {
        log('Initializing Grok Image Saver...');
        currentConversationId = getCurrentConversationId();
        addControlPanel();
        observeGrokConversation();
        setTimeout(scanForExistingImages, 2000);
        setInterval(scanForExistingImages, 10000);
    }

    // Start the script
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
