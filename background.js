// todo
// Rewrite the notification section using alarms possibly

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
const windows = {}; // Maps window IDs to the most recently active tab in that window

chrome.runtime.onInstalled.addListener(async () => {

  // Fetch and cache all open tabs
  chrome.tabs.query({}, (tabs) => {
    cachedTabs = tabs.map(
      (tab) =>
        new Tab(tab.id, tab.title, tab.url, tab.favIconUrl, tab.lastAccessed)
    );

    saveTabsToStorage();
    setInactivityThreshold();
  });

  // Store currently active tabs per window
  chrome.tabs.query({ active: true }, (tabs) => {
    tabs.forEach((tab) => {
      windows[tab.windowId] = tab.id;
    });
  });
  await setWindows(); // Save to storage

  // Set up the alarm initially after a short delay
  setTimeout(setupAlarm, 1000);
});

async function setWindows() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ windows }, () => {
      if (chrome.runtime.lastError) {
        console.error("Error saving windows:", chrome.runtime.lastError);
        return reject(chrome.runtime.lastError);
      }
      resolve();
    });
  });
}

async function loadWindows() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get("windows", (data) => {
      if (chrome.runtime.lastError) {
        console.error("Error loading windows:", chrome.runtime.lastError);
        return reject(chrome.runtime.lastError);
      }

      // Ensure we merge into the existing `windows` object to retain reference
      Object.assign(windows, data.windows || {});
      resolve();
    });
  });
}

// Triggered when the browser starts up
chrome.runtime.onStartup.addListener(async () => {

  chrome.tabs.query({}, (tabs) => {
    cachedTabs = tabs.map(
      (tab) =>
        new Tab(tab.id, tab.title, tab.url, tab.favIconUrl, tab.lastAccessed)
    );

    saveTabsToStorage(); // Save the tabs to storage
  });

  try {
    await setInactivityThreshold(); // Fetch the inactivity threshold

    // Set the current active tabs for all windows
    chrome.tabs.query({ active: true }, (tabs) => {
      tabs.forEach((tab) => {
        windows.windowId = tab.id;
      });
    });

    await setWindows();
  } catch (error) {
    console.error("Error during startup:", error);
  }

  // Set up the alarm initially after a short delay
  setTimeout(setupAlarm, 1000);
});

// Fetch and cache inactivity threshold from storage
async function setInactivityThreshold() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get("inactivityThreshold", (data) => {
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      inactivityThreshold = data.inactivityThreshold || {
        hours: 0,
        minutes: 30,
      }; // Default to 30 minutes if not set
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
  }, 800);
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
  chrome.storage.local.set({ totalTabChunks: tabChunks.length }, () => {
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
    chrome.storage.local.get("totalTabChunks", (data) => {
      if (chrome.runtime.lastError || !data.totalTabChunks) {
        console.error(
          "Error fetching totalTabChunks:",
          chrome.runtime.lastError
        );
        return reject(new Error("Failed to load tab chunks"));
      }

      const totalChunks = data.totalTabChunks;
      let loadedTabs = [];

      // Fetch each chunk and concatenate them
      let chunksLoaded = 0;
      for (let i = 0; i < totalChunks; i++) {
        chrome.storage.local.get([`tabs_chunk_${i}`], (chunkData) => {
          if (chrome.runtime.lastError) {
            console.error(
              `Error fetching chunk ${i}:`,
              chrome.runtime.lastError
            );
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
async function createOrUpdate(tab) {
  if (cachedTabs.length == 0) {
    await loadTabsFromStorage();
  }
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
  }

  debouncedSave();
}

// Handle tab creation
chrome.tabs.onCreated.addListener((tab) => createOrUpdate(tab));

// Handle tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
  createOrUpdate(tab)
);

const onActivated = async (activeInfo) => {
  setTimeout(async () => {
    if (cachedTabs.length == 0) {
      console.log("Here in the activated, loading tabs from storage")
      
      await loadTabsFromStorage();
    }
    await loadWindows();
  
    // Check if this window was previously tracked
    if (windows.hasOwnProperty(activeInfo.windowId)) {
      const prevTabId = windows[activeInfo.windowId]; // Previously active tab in this window
  
      // Update last accessed timestamps only if the previous tab existed
      cachedTabs = cachedTabs.map((tab) => {
        if (tab.id === prevTabId || tab.id === activeInfo.tabId) {
          return { ...tab, lastAccessed: Date.now() };
        }
        return tab;
      });
    }
  
    // Update or create the active tab entry for this window
    windows[activeInfo.windowId] = activeInfo.tabId;
  
    await setWindows(); // Save changes to storage
    debouncedSave();
  }, 600)
}

chrome.tabs.onActivated.addListener(activeInfo => onActivated(activeInfo));

// Handle tab removal
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (cachedTabs.length == 0) {
    console.log("Fetching tabs from storage as the cache is empty...")
    await loadTabsFromStorage();
    console.log("Cache is locked and loaded...")
  }
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

// Set up an alarm-based interval for checking inactive tabs
async function setupAlarm() {
  const intervalTime = await getInactivityThreshold();

  // Clear existing alarm
  chrome.alarms.clear("tabifyAlarm", () => {
    // Create a new alarm with the updated interval
    chrome.alarms.create("tabifyAlarm", {
      periodInMinutes: intervalTime / 60000, // Convert milliseconds to minutes
    });

    console.log("Alarm is created for time ", inactivityThreshold)
  });
}

// Function to check for inactive tabs
async function checkInactiveTabs() {
  console.log("Inside check inactive tabs, will send notification soon!");
  
  await loadTabsFromStorage();
  await setInactivityThreshold();
  const intervalTime = await getInactivityThreshold();
  
  
  chrome.tabs.query({ active: true }, (tabs) => {
    const activeTabs = new Set();
    tabs.forEach((tab) => activeTabs.add(tab.id));

    // Update last accessed time for active tabs
    cachedTabs = cachedTabs.map((tab) =>
      activeTabs.has(tab.id) ? { ...tab, lastAccessed: Date.now() } : tab
    );

    // Filter inactive tabs
    cachedInactiveTabs = cachedTabs.filter(
      (tab) => Date.now() - tab.lastAccessed > intervalTime
    );

    console.log(activeTabs)
    console.log(cachedInactiveTabs)
    console.log(cachedInactiveTabs.length > 0)

    // Show notification if inactive tabs exist
    if (cachedInactiveTabs.length > 0) {
      chrome.notifications.create("tabifyNotification", {
        iconUrl: "notification.png",
        title: "Inactive Tabs Detected!",
        message: `You have ${cachedInactiveTabs.length} inactive tabs slowing you down. Choose an option below to clean them up!`,
        type: "basic",
        buttons: [
          { title: "Clean All Inactive Tabs" },
          { title: "Review Tabs" },
        ],
        priority: 2,
      }, (notificationId) => {
        console.log("notification created with id : ", notificationId)
      });
    }
  });
}

// Listen for alarm triggers and execute the check function
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tabifyAlarm") {
    checkInactiveTabs();
  }
});



// Update the alarm when the inactivity threshold changes
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (changes.inactivityThreshold && areaName === "local") {
    inactivityThreshold = changes.inactivityThreshold.newValue;
    setupAlarm(); // Reset the alarm with the new threshold
  }
});

// Handle button clicks in the notification
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (notificationId === "tabifyNotification") {
    const interval = await getInactivityThreshold();
    if (buttonIndex === 0) {
      // Clean all inactive tabs
      console.log("Cleaning all Inactive Tabs....");
      let wait = true;

      cachedInactiveTabs.forEach((tab) => {
        if (wait) {
          setTimeout(() => {
            chrome.tabs.remove(tab.id);
          }, 500);
          wait = false;
        } else {
          chrome.tabs.remove(tab.id);
        }
      });

      const activeTabs = new Set();
      chrome.tabs.query({ active: true }, (result) => {
        result.forEach((tab) => activeTabs.add(tab.id));

        cachedTabs = cachedTabs.filter(
          (tab) => Date.now() - tab.lastAccessed < interval || activeTabs.has(tab.id)
        );
      });
    } else if (buttonIndex === 1) {
      // Open a new tab to review inactive tabs
      console.log("Review Tabs clicked");
      chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
    }
  }
});
