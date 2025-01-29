class Tab {
  constructor(id, title, url, tabFavicon, lastAccessed) {
    this.id = id;
    this.title = title;
    this.url = url;
    this.tabFavicon = tabFavicon;
    this.lastAccessed = lastAccessed;
  }

  // Update tab fields
  update(updatedFields) {
    Object.assign(this, updatedFields);
  }
}

let cachedTabs = []; // Stores all tabs
let cachedInactiveTabs = []; // Stores inactive tabs based on threshold
let inactivityThreshold = { minutes: 30, hours: 0 }; // Default inactivity threshold
const windows = new Map(); // Maps window IDs to the most recently active tab in that window

// Triggered when the extension is installed
chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed!");

  // Fetch and cache all open tabs on installation
  chrome.tabs.query({}, (tabs) => {
    cachedTabs = tabs.map(
      (tab) =>
        new Tab(tab.id, tab.title, tab.url, tab.favIconUrl, tab.lastAccessed)
    );

    saveTabsToStorage(); // Save the tabs to storage
    setInactivityThreshold(); // Fetch the inactivity threshold from storage
  });

  // Set the current active tabs for all windows
  chrome.tabs.query({ active: true }, (tabs) => {
    tabs.forEach((tab) => {
      windows.set(tab.windowId, tab.id);
    });
  });
});

// Triggered when the browser starts up
chrome.runtime.onStartup.addListener(async () => {
  console.log("Extension started!");

  try {
    // Fetch and cache all open tabs
    await loadTabsFromStorage(); // Load tabs from storage asynchronously
    await setInactivityThreshold(); // Fetch the inactivity threshold
    saveTabsToStorage(); // Save the tabs to storage

    // Set the current active tabs for all windows
    chrome.tabs.query({ active: true }, (tabs) => {
      tabs.forEach((tab) => {
        windows.set(tab.windowId, tab.id);
      });
    });
  } catch (error) {
    console.error("Error during startup:", error);
  }
});

// Fetch and cache inactivity threshold from storage
async function setInactivityThreshold() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get("inactivityThreshold", (data) => {
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      inactivityThreshold = data.inactivityThreshold || { hours: 0, minutes: 30 }; // Default to 30 minutes if not set
      console.log("Inactivity threshold set:", inactivityThreshold);
      resolve();
    });
  });
}

let debouncedTimeout; // For save operations

// Debounced save function to prevent frequent writes to storage
function debouncedSave() {
  clearTimeout(debouncedTimeout);

  debouncedTimeout = setTimeout(() => {
    saveTabsToStorage();
  }, 300);
}

// Function to chunk the data into smaller pieces (25 tabs per chunk)
function chunkData(data, chunkSize = 25) {
  const chunks = [];
  let currentChunk = [];

  // Iterate over the data and chunk it into arrays with at most 'chunkSize' elements
  data.forEach((item, index) => {
    currentChunk.push(item);

    // If the chunk size reaches the limit, push it and start a new chunk
    if (currentChunk.length === chunkSize || index === data.length - 1) {
      chunks.push(currentChunk);
      currentChunk = []; // Reset for the next chunk
    }
  });

  return chunks;
}

// Save tabs to Chrome's storage in chunks
function saveTabsToStorage() {
  // Split the tabs into smaller chunks (25 tabs per chunk)
  const tabChunks = chunkData(cachedTabs, 25);
  
  tabChunks.forEach((chunk, index) => {
    chrome.storage.local.set({ [`tabs_chunk_${index}`]: chunk }, () => {
      if (chrome.runtime.lastError) {
        console.error(`Error saving chunk ${index}:`, chrome.runtime.lastError);
      } else {
        console.log(`Chunk ${index} saved successfully`);
      }
    });
  });

  // Optionally, store the total number of chunks so you can track how many chunks exist
  chrome.storage.local.set({ 'totalTabChunks': tabChunks.length }, () => {
    if (chrome.runtime.lastError) {
      console.error("Error saving totalTabChunks:", chrome.runtime.lastError);
    } else {
      console.log("Total tab chunks count saved successfully");
    }
  });
}

// Fetch all tab chunks and reassemble the full list of tabs
function loadTabsFromStorage() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get('totalTabChunks', (data) => {
      if (chrome.runtime.lastError || !data.totalTabChunks) {
        console.error('Error fetching totalTabChunks:', chrome.runtime.lastError);
        return reject(new Error('Failed to load tab chunks'));
      }

      const totalChunks = data.totalTabChunks;
      let loadedTabs = [];

      // Fetch each chunk and concatenate them
      let chunksLoaded = 0;
      for (let i = 0; i < totalChunks; i++) {
        chrome.storage.local.get([`tabs_chunk_${i}`], (chunkData) => {
          if (chrome.runtime.lastError) {
            console.error(`Error fetching chunk ${i}:`, chrome.runtime.lastError);
          } else if (chunkData[`tabs_chunk_${i}`]) {
            loadedTabs = loadedTabs.concat(chunkData[`tabs_chunk_${i}`]);
          }

          chunksLoaded++;

          // Once all chunks are loaded, update cachedTabs
          if (chunksLoaded === totalChunks) {
            cachedTabs = loadedTabs;
            console.log("Tabs loaded and reassembled:", cachedTabs);
            resolve(); // Resolve when all chunks are loaded
          }
        });
      }
    });
  });
}

// Create or update a tab in the cachedTabs array
function createOrUpdate(tab) {
  const tabIdx = cachedTabs.findIndex((t) => t.id === tab.id);

  if (tabIdx !== -1) {
    // Tab exists, update it only if it's fully loaded
    if (tab.status === "complete") {
      cachedTabs[tabIdx] = {
        id: cachedTabs[tabIdx].id,
        title: tab.title || cachedTabs[tabIdx].title,
        url: tab.url || cachedTabs[tabIdx].url,
        tabFavicon: tab.favIconUrl || cachedTabs[tabIdx].tabFavicon,
        lastAccessed: tab.lastAccessed || cachedTabs[tabIdx].lastAccessed,
      };

      console.log("Tab Updated:", tab.title);
    }
  } else {
    // Tab doesn't exist, create a new one
    cachedTabs.push(
      new Tab(
        tab.id,
        tab.title || "New Tab",
        tab.url || "",
        tab.favIconUrl || "",
        tab.lastAccessed
      )
    );
    console.log("New Tab added");
  }

  debouncedSave();
}

// Handle tab creation
chrome.tabs.onCreated.addListener((tab) => createOrUpdate(tab));

// Handle tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
  createOrUpdate(tab)
);

// Handle tab activation (switching between tabs)
chrome.tabs.onActivated.addListener((activeInfo) => {
  if (windows.has(activeInfo.windowId)) {
    const prevTab = windows.get(activeInfo.windowId); // Get the previously active tab in the same window

    // Update the last accessed timestamp for the previous tab
    cachedTabs = cachedTabs.map((tab) => {
      if (tab.id === prevTab) {
        return { ...tab, lastAccessed: Date.now() };
      } else if (tab.id === activeInfo.tabId) {
        return { ...tab, lastAccessed: Date.now() };
      } else {
        return tab;
      }
    });
  }

  // Update the active tab in the current window or the newly created tab in a fresh window
  windows.set(activeInfo.windowId, activeInfo.tabId);
  debouncedSave();
});

// Handle tab removal
chrome.tabs.onRemoved.addListener((tabId) => {
  if (chrome.runtime.lastError) {
    console.error(
      `Error removing tab with ID: ${tabId.toString()} due to ${
        chrome.runtime.lastError
      }`
    );
  }
  cachedTabs = cachedTabs.filter((t) => t.id !== tabId); // Remove the tab from cachedTabs
  console.log("Tab Removed:", tabId);
  debouncedSave();
});

// Get inactivity threshold in milliseconds
function getInactivityThreshold() {
  return new Promise((resolve) => {
    resolve(
      (inactivityThreshold.minutes + inactivityThreshold.hours * 60) * 60000
    );
  });
}

// Setup periodic inactivity check
let intervalId; // Holds the reference to the interval

// Function to set up the interval with the current inactivity threshold
async function setupInterval() {
  const intervalTime = await getInactivityThreshold();
  console.log("Interval Time Set:", intervalTime);

  if (intervalId) {
    clearInterval(intervalId); // Clear the existing interval
    console.log("Previous interval cleared");
  }

  intervalId = setInterval(() => {
    // Get all active tabs
    chrome.tabs.query({ active: true }, (tabs) => {
      const activeTabs = new Set();
      tabs.forEach((tab) => activeTabs.add(tab.id));

      // Update last accessed time for active tabs
      cachedTabs = cachedTabs.map((tab) =>
        activeTabs.has(tab.id) ? { ...tab, lastAccessed: Date.now() } : tab
      );

      // Filter inactive tabs based on the threshold
      cachedInactiveTabs = cachedTabs.filter(
        (tab) => (Date.now() - tab.lastAccessed) > intervalTime
      );

      console.log(activeTabs);
      console.log(cachedInactiveTabs);

      console.log(cachedInactiveTabs.length > 0);

      // Show notification if there are inactive tabs
      if (cachedInactiveTabs.length > 0) {
        chrome.notifications.create(
          "tabifyNotification",
          {
            iconUrl: "notification.png",
            title: "Inactive Tabs Detected!",
            message: `You have ${cachedInactiveTabs.length} inactive tabs slowing you down. Choose an option below to clean them up!`,
            type: "basic",
            buttons: [
              { title: "Clean All Inactive Tabs" },
              { title: "Review Tabs" },
            ],
          },
          (notificationId) => {
            console.log(`Notification created with ID: ${notificationId}`);
          }
        );
      }
    });

  }, intervalTime);
}

// Initial setup of the inactivity check interval
setTimeout(setupInterval, 1000);

// Listen for changes to the inactivity threshold in storage
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (changes.inactivityThreshold && areaName === "local") {
    inactivityThreshold = changes.inactivityThreshold.newValue; // Update the threshold
    console.log("Updated inactivity threshold:", inactivityThreshold);
    setupInterval(); // Re-setup the interval with the new threshold
  }
});

// Handle button clicks in the notification
chrome.notifications.onButtonClicked.addListener(
  async (notificationId, buttonIndex) => {
    if (notificationId === "tabifyNotification") {
      if (buttonIndex === 0) {
        // Clean all inactive tabs
        console.log("Cleaning all Inactive Tabs....");
        const interval = await getInactivityThreshold();

        // Remove all inactive tabs
        cachedInactiveTabs.forEach((tab) => chrome.tabs.remove(tab.id));

        const activeTabs = new Set();

        chrome.tabs.query({ active: true }, (result) => {
          result.forEach((tab) => activeTabs.add(tab.id));
          
          cachedTabs = cachedTabs.filter(
            (tab) => (Date.now() - tab.lastAccessed) < interval || activeTabs.has(tab.id)
          );


          debouncedSave();
        });
      } else if (buttonIndex === 1) {
        // Open a new tab to review inactive tabs
        console.log("Review Tabs clicked");
        chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
      }
    }
  }
);
