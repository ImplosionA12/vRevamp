
// script.js

// GitHub repository details
const owner = "sanjay7178";
const repo = "vRevamp";

async function fetchContributors() {
  // The outer try/catch never covered any of this — everything below runs in
  // an async storage callback, so a throw here escaped as an unhandled
  // rejection. It could throw, too: an unauthenticated GitHub API call is
  // rate-limited to 60/h/IP and then answers 403 with an OBJECT
  // ({"message":"API rate limit exceeded"}), not an array. That object was
  // written straight to storage, so .forEach threw AND the junk was cached
  // permanently — the list stayed empty on every later popup open.
  chrome.storage.local.get("contributors", async function (data) {
    try {
      let contributors = data.contributors;
      if (!Array.isArray(contributors)) {
        const response = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contributors`
        );
        if (!response.ok) throw new Error("HTTP " + response.status);
        contributors = await response.json();
        if (!Array.isArray(contributors))
          throw new Error("unexpected response shape");
        chrome.storage.local.set({ contributors: contributors });
      }
      displayContributors(contributors);
    } catch (error) {
      console.error("Error fetching contributors:", error);
    }
  });
}

// Function to display contributors on the webpage
function displayContributors(contributors) {
  const contributorsList = document.getElementById("contributors-list");

  contributors.forEach((contributor) => {
    const listItem = document.createElement("li");

    const profileLink = document.createElement("a");
    profileLink.href = contributor.html_url;
    profileLink.target = "_blank"; // Open link in new tab
    profileLink.textContent = contributor.login;

    const profileImage = document.createElement("img");
    profileImage.src = contributor.avatar_url;
    profileImage.alt = `${contributor.login}'s GitHub Profile Picture`;
    profileImage.width = 20;
    profileImage.height = 20;
    profileImage.style.borderRadius = "50%";
    profileImage.style.marginLeft = "10px";

    profileLink.appendChild(profileImage);
    listItem.appendChild(profileLink);

    contributorsList.appendChild(listItem);
  });
}

// Fetch contributors when the page loads
fetchContributors();
