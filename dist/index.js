// src/index.ts
import { elizaLogger as elizaLogger5 } from "@ai16z/eliza";

// src/base.ts
import {
  getEmbeddingZeroVector,
  elizaLogger,
  stringToUuid
} from "@ai16z/eliza";
import {
  Scraper,
  SearchMode
} from "agent-twitter-client";
import { EventEmitter } from "events";
var RequestQueue = class {
  queue = [];
  processing = false;
  async add(request) {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await request();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.processQueue();
    });
  }
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }
    this.processing = true;
    while (this.queue.length > 0) {
      const request = this.queue.shift();
      try {
        await request();
      } catch (error) {
        console.error("Error processing request:", error);
        this.queue.unshift(request);
        await this.exponentialBackoff(this.queue.length);
      }
      await this.randomDelay();
    }
    this.processing = false;
  }
  async exponentialBackoff(retryCount) {
    const delay = Math.pow(2, retryCount) * 1e3;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  async randomDelay() {
    const delay = Math.floor(Math.random() * 2e3) + 1500;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
};
var ClientBase = class _ClientBase extends EventEmitter {
  static _twitterClients = {};
  twitterClient;
  runtime;
  directions;
  lastCheckedTweetId = null;
  imageDescriptionService;
  temperature = 0.5;
  requestQueue = new RequestQueue();
  profile;
  async cacheTweet(tweet) {
    if (!tweet) {
      console.warn("Tweet is undefined, skipping cache");
      return;
    }
    this.runtime.cacheManager.set(`twitter/tweets/${tweet.id}`, tweet);
  }
  async getCachedTweet(tweetId) {
    const cached = await this.runtime.cacheManager.get(
      `twitter/tweets/${tweetId}`
    );
    return cached;
  }
  async getTweet(tweetId) {
    const cachedTweet = await this.getCachedTweet(tweetId);
    if (cachedTweet) {
      return cachedTweet;
    }
    const tweet = await this.requestQueue.add(
      () => this.twitterClient.getTweet(tweetId)
    );
    await this.cacheTweet(tweet);
    return tweet;
  }
  callback = null;
  onReady() {
    throw new Error(
      "Not implemented in base class, please call from subclass"
    );
  }
  constructor(runtime) {
    super();
    this.runtime = runtime;
    const username = this.runtime.getSetting("TWITTER_USERNAME");
    if (_ClientBase._twitterClients[username]) {
      this.twitterClient = _ClientBase._twitterClients[username];
    } else {
      this.twitterClient = new Scraper();
      _ClientBase._twitterClients[username] = this.twitterClient;
    }
    this.directions = "- " + this.runtime.character.style.all.join("\n- ") + "- " + this.runtime.character.style.post.join();
  }
  async init() {
    const username = this.runtime.getSetting("TWITTER_USERNAME");
    const password = this.runtime.getSetting("TWITTER_PASSWORD");
    const email = this.runtime.getSetting("TWITTER_EMAIL");
    let retries = parseInt(
      this.runtime.getSetting("TWITTER_RETRY_LIMIT") || "5",
      10
    );
    const twitter2faSecret = this.runtime.getSetting("TWITTER_2FA_SECRET") || void 0;
    const cookies = this.runtime.getSetting("TWITTER_COOKIES");
    if (!username) {
      throw new Error("Twitter username not configured");
    }
    if (cookies) {
      elizaLogger.debug("Using cookies from settings");
      const cookiesArray = JSON.parse(cookies);
      await this.setCookiesFromArray(cookiesArray);
    } else {
      elizaLogger.debug("No cookies found in settings");
      elizaLogger.debug("Checking for cached cookies");
      const cachedCookies = await this.getCachedCookies(username);
      if (cachedCookies) {
        await this.setCookiesFromArray(cachedCookies);
      }
    }
    elizaLogger.log("Waiting for Twitter login");
    while (retries > 0) {
      const cookies2 = await this.twitterClient.getCookies();
      if (await this.twitterClient.isLoggedIn() && !!cookies2) {
        elizaLogger.info("Already logged in.");
        await this.cacheCookies(username, cookies2);
        elizaLogger.info("Successfully logged in and cookies cached.");
        break;
      }
      try {
        await this.twitterClient.login(
          username,
          password,
          email,
          twitter2faSecret
        );
      } catch (error) {
        elizaLogger.error(`Login attempt failed: ${error.message}`);
      }
      retries--;
      elizaLogger.error(
        `Failed to login to Twitter. Retrying... (${retries} attempts left)`
      );
      if (retries === 0) {
        elizaLogger.error(
          "Max retries reached. Exiting login process."
        );
        throw new Error("Twitter login failed after maximum retries.");
      }
      await new Promise((resolve) => setTimeout(resolve, 2e3));
    }
    this.profile = await this.fetchProfile(username);
    if (this.profile) {
      elizaLogger.log("Twitter user ID:", this.profile.id);
      elizaLogger.log(
        "Twitter loaded:",
        JSON.stringify(this.profile, null, 10)
      );
      this.runtime.character.twitterProfile = {
        id: this.profile.id,
        username: this.profile.username,
        screenName: this.profile.screenName,
        bio: this.profile.bio,
        nicknames: this.profile.nicknames
      };
    } else {
      throw new Error("Failed to load profile");
    }
    await this.loadLatestCheckedTweetId();
    await this.populateTimeline();
  }
  async fetchOwnPosts(count) {
    elizaLogger.debug("fetching own posts");
    const homeTimeline = await this.twitterClient.getUserTweets(
      this.profile.id,
      count
    );
    return homeTimeline.tweets;
  }
  async fetchHomeTimeline(count) {
    elizaLogger.debug("fetching home timeline");
    const homeTimeline = await this.twitterClient.fetchHomeTimeline(
      count,
      []
    );
    elizaLogger.debug(homeTimeline, { depth: Infinity });
    const processedTimeline = homeTimeline.filter((t) => t.__typename !== "TweetWithVisibilityResults").map((tweet) => {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y;
      const obj = {
        id: tweet.id,
        name: tweet.name ?? ((_b = (_a = tweet == null ? void 0 : tweet.user_results) == null ? void 0 : _a.result) == null ? void 0 : _b.legacy.name),
        username: tweet.username ?? ((_e = (_d = (_c = tweet.core) == null ? void 0 : _c.user_results) == null ? void 0 : _d.result) == null ? void 0 : _e.legacy.screen_name),
        text: tweet.text ?? ((_f = tweet.legacy) == null ? void 0 : _f.full_text),
        inReplyToStatusId: tweet.inReplyToStatusId ?? ((_g = tweet.legacy) == null ? void 0 : _g.in_reply_to_status_id_str) ?? null,
        timestamp: new Date((_h = tweet.legacy) == null ? void 0 : _h.created_at).getTime() / 1e3,
        createdAt: tweet.createdAt ?? ((_i = tweet.legacy) == null ? void 0 : _i.created_at) ?? ((_l = (_k = (_j = tweet.core) == null ? void 0 : _j.user_results) == null ? void 0 : _k.result) == null ? void 0 : _l.legacy.created_at),
        userId: tweet.userId ?? ((_m = tweet.legacy) == null ? void 0 : _m.user_id_str),
        conversationId: tweet.conversationId ?? ((_n = tweet.legacy) == null ? void 0 : _n.conversation_id_str),
        permanentUrl: `https://x.com/${(_r = (_q = (_p = (_o = tweet.core) == null ? void 0 : _o.user_results) == null ? void 0 : _p.result) == null ? void 0 : _q.legacy) == null ? void 0 : _r.screen_name}/status/${tweet.rest_id}`,
        hashtags: tweet.hashtags ?? ((_s = tweet.legacy) == null ? void 0 : _s.entities.hashtags),
        mentions: tweet.mentions ?? ((_t = tweet.legacy) == null ? void 0 : _t.entities.user_mentions),
        photos: tweet.photos ?? ((_v = (_u = tweet.legacy) == null ? void 0 : _u.entities.media) == null ? void 0 : _v.filter(
          (media) => media.type === "photo"
        )) ?? [],
        thread: tweet.thread || [],
        urls: tweet.urls ?? ((_w = tweet.legacy) == null ? void 0 : _w.entities.urls),
        videos: tweet.videos ?? ((_y = (_x = tweet.legacy) == null ? void 0 : _x.entities.media) == null ? void 0 : _y.filter(
          (media) => media.type === "video"
        )) ?? []
      };
      return obj;
    });
    return processedTimeline;
  }
  async fetchTimelineForActions(count) {
    elizaLogger.debug("fetching timeline for actions");
    const homeTimeline = await this.twitterClient.fetchHomeTimeline(
      count,
      []
    );
    return homeTimeline.map((tweet) => {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _A, _B, _C;
      return {
        id: tweet.rest_id,
        name: (_d = (_c = (_b = (_a = tweet.core) == null ? void 0 : _a.user_results) == null ? void 0 : _b.result) == null ? void 0 : _c.legacy) == null ? void 0 : _d.name,
        username: (_h = (_g = (_f = (_e = tweet.core) == null ? void 0 : _e.user_results) == null ? void 0 : _f.result) == null ? void 0 : _g.legacy) == null ? void 0 : _h.screen_name,
        text: (_i = tweet.legacy) == null ? void 0 : _i.full_text,
        inReplyToStatusId: (_j = tweet.legacy) == null ? void 0 : _j.in_reply_to_status_id_str,
        timestamp: new Date((_k = tweet.legacy) == null ? void 0 : _k.created_at).getTime() / 1e3,
        userId: (_l = tweet.legacy) == null ? void 0 : _l.user_id_str,
        conversationId: (_m = tweet.legacy) == null ? void 0 : _m.conversation_id_str,
        permanentUrl: `https://twitter.com/${(_q = (_p = (_o = (_n = tweet.core) == null ? void 0 : _n.user_results) == null ? void 0 : _o.result) == null ? void 0 : _p.legacy) == null ? void 0 : _q.screen_name}/status/${tweet.rest_id}`,
        hashtags: ((_s = (_r = tweet.legacy) == null ? void 0 : _r.entities) == null ? void 0 : _s.hashtags) || [],
        mentions: ((_u = (_t = tweet.legacy) == null ? void 0 : _t.entities) == null ? void 0 : _u.user_mentions) || [],
        photos: ((_x = (_w = (_v = tweet.legacy) == null ? void 0 : _v.entities) == null ? void 0 : _w.media) == null ? void 0 : _x.filter(
          (media) => media.type === "photo"
        )) || [],
        thread: tweet.thread || [],
        urls: ((_z = (_y = tweet.legacy) == null ? void 0 : _y.entities) == null ? void 0 : _z.urls) || [],
        videos: ((_C = (_B = (_A = tweet.legacy) == null ? void 0 : _A.entities) == null ? void 0 : _B.media) == null ? void 0 : _C.filter(
          (media) => media.type === "video"
        )) || []
      };
    });
  }
  async fetchSearchTweets(query, maxTweets, searchMode, cursor) {
    try {
      const timeoutPromise = new Promise(
        (resolve) => setTimeout(() => resolve({ tweets: [] }), 1e4)
      );
      try {
        const result = await this.requestQueue.add(
          async () => await Promise.race([
            this.twitterClient.fetchSearchTweets(
              query,
              maxTweets,
              searchMode,
              cursor
            ),
            timeoutPromise
          ])
        );
        return result ?? { tweets: [] };
      } catch (error) {
        elizaLogger.error("Error fetching search tweets:", error);
        return { tweets: [] };
      }
    } catch (error) {
      elizaLogger.error("Error fetching search tweets:", error);
      return { tweets: [] };
    }
  }
  async populateTimeline() {
    elizaLogger.debug("populating timeline...");
    const cachedTimeline = await this.getCachedTimeline();
    if (cachedTimeline) {
      const existingMemories2 = await this.runtime.messageManager.getMemoriesByRoomIds({
        roomIds: cachedTimeline.map(
          (tweet) => stringToUuid(
            tweet.conversationId + "-" + this.runtime.agentId
          )
        )
      });
      const existingMemoryIds2 = new Set(
        existingMemories2.map((memory) => memory.id.toString())
      );
      const someCachedTweetsExist = cachedTimeline.some(
        (tweet) => existingMemoryIds2.has(
          stringToUuid(tweet.id + "-" + this.runtime.agentId)
        )
      );
      if (someCachedTweetsExist) {
        const tweetsToSave2 = cachedTimeline.filter(
          (tweet) => !existingMemoryIds2.has(
            stringToUuid(tweet.id + "-" + this.runtime.agentId)
          )
        );
        console.log({
          processingTweets: tweetsToSave2.map((tweet) => tweet.id).join(",")
        });
        for (const tweet of tweetsToSave2) {
          elizaLogger.log("Saving Tweet", tweet.id);
          const roomId = stringToUuid(
            tweet.conversationId + "-" + this.runtime.agentId
          );
          const userId = tweet.userId === this.profile.id ? this.runtime.agentId : stringToUuid(tweet.userId);
          if (tweet.userId === this.profile.id) {
            await this.runtime.ensureConnection(
              this.runtime.agentId,
              roomId,
              this.profile.username,
              this.profile.screenName,
              "twitter"
            );
          } else {
            await this.runtime.ensureConnection(
              userId,
              roomId,
              tweet.username,
              tweet.name,
              "twitter"
            );
          }
          const content = {
            text: tweet.text,
            url: tweet.permanentUrl,
            source: "twitter",
            inReplyTo: tweet.inReplyToStatusId ? stringToUuid(
              tweet.inReplyToStatusId + "-" + this.runtime.agentId
            ) : void 0
          };
          elizaLogger.log("Creating memory for tweet", tweet.id);
          const memory = await this.runtime.messageManager.getMemoryById(
            stringToUuid(tweet.id + "-" + this.runtime.agentId)
          );
          if (memory) {
            elizaLogger.log(
              "Memory already exists, skipping timeline population"
            );
            break;
          }
          await this.runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
            userId,
            content,
            agentId: this.runtime.agentId,
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: tweet.timestamp * 1e3
          });
          await this.cacheTweet(tweet);
        }
        elizaLogger.log(
          `Populated ${tweetsToSave2.length} missing tweets from the cache.`
        );
        return;
      }
    }
    const timeline = await this.fetchHomeTimeline(cachedTimeline ? 10 : 50);
    const username = this.runtime.getSetting("TWITTER_USERNAME");
    const mentionsAndInteractions = await this.fetchSearchTweets(
      `@${username}`,
      20,
      SearchMode.Latest
    );
    const allTweets = [...timeline, ...mentionsAndInteractions.tweets];
    const tweetIdsToCheck = /* @__PURE__ */ new Set();
    const roomIds = /* @__PURE__ */ new Set();
    for (const tweet of allTweets) {
      tweetIdsToCheck.add(tweet.id);
      roomIds.add(
        stringToUuid(tweet.conversationId + "-" + this.runtime.agentId)
      );
    }
    const existingMemories = await this.runtime.messageManager.getMemoriesByRoomIds({
      roomIds: Array.from(roomIds)
    });
    const existingMemoryIds = new Set(
      existingMemories.map((memory) => memory.id)
    );
    const tweetsToSave = allTweets.filter(
      (tweet) => !existingMemoryIds.has(
        stringToUuid(tweet.id + "-" + this.runtime.agentId)
      )
    );
    elizaLogger.debug({
      processingTweets: tweetsToSave.map((tweet) => tweet.id).join(",")
    });
    await this.runtime.ensureUserExists(
      this.runtime.agentId,
      this.profile.username,
      this.runtime.character.name,
      "twitter"
    );
    for (const tweet of tweetsToSave) {
      elizaLogger.log("Saving Tweet", tweet.id);
      const roomId = stringToUuid(
        tweet.conversationId + "-" + this.runtime.agentId
      );
      const userId = tweet.userId === this.profile.id ? this.runtime.agentId : stringToUuid(tweet.userId);
      if (tweet.userId === this.profile.id) {
        await this.runtime.ensureConnection(
          this.runtime.agentId,
          roomId,
          this.profile.username,
          this.profile.screenName,
          "twitter"
        );
      } else {
        await this.runtime.ensureConnection(
          userId,
          roomId,
          tweet.username,
          tweet.name,
          "twitter"
        );
      }
      const content = {
        text: tweet.text,
        url: tweet.permanentUrl,
        source: "twitter",
        inReplyTo: tweet.inReplyToStatusId ? stringToUuid(tweet.inReplyToStatusId) : void 0
      };
      await this.runtime.messageManager.createMemory({
        id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
        userId,
        content,
        agentId: this.runtime.agentId,
        roomId,
        embedding: getEmbeddingZeroVector(),
        createdAt: tweet.timestamp * 1e3
      });
      await this.cacheTweet(tweet);
    }
    await this.cacheTimeline(timeline);
    await this.cacheMentions(mentionsAndInteractions.tweets);
  }
  async setCookiesFromArray(cookiesArray) {
    const cookieStrings = cookiesArray.map(
      (cookie) => `${cookie.key}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}; ${cookie.secure ? "Secure" : ""}; ${cookie.httpOnly ? "HttpOnly" : ""}; SameSite=${cookie.sameSite || "Lax"}`
    );
    await this.twitterClient.setCookies(cookieStrings);
  }
  async saveRequestMessage(message, state) {
    if (message.content.text) {
      const recentMessage = await this.runtime.messageManager.getMemories(
        {
          roomId: message.roomId,
          count: 1,
          unique: false
        }
      );
      if (recentMessage.length > 0 && recentMessage[0].content === message.content) {
        elizaLogger.debug("Message already saved", recentMessage[0].id);
      } else {
        await this.runtime.messageManager.createMemory({
          ...message,
          embedding: getEmbeddingZeroVector()
        });
      }
      await this.runtime.evaluate(message, {
        ...state,
        twitterClient: this.twitterClient
      });
    }
  }
  async loadLatestCheckedTweetId() {
    const latestCheckedTweetId = await this.runtime.cacheManager.get(
      `twitter/${this.profile.username}/latest_checked_tweet_id`
    );
    if (latestCheckedTweetId) {
      this.lastCheckedTweetId = BigInt(latestCheckedTweetId);
    }
  }
  async cacheLatestCheckedTweetId() {
    if (this.lastCheckedTweetId) {
      await this.runtime.cacheManager.set(
        `twitter/${this.profile.username}/latest_checked_tweet_id`,
        this.lastCheckedTweetId.toString()
      );
    }
  }
  async getCachedTimeline() {
    return await this.runtime.cacheManager.get(
      `twitter/${this.profile.username}/timeline`
    );
  }
  async cacheTimeline(timeline) {
    await this.runtime.cacheManager.set(
      `twitter/${this.profile.username}/timeline`,
      timeline,
      { expires: Date.now() + 10 * 1e3 }
    );
  }
  async cacheMentions(mentions) {
    await this.runtime.cacheManager.set(
      `twitter/${this.profile.username}/mentions`,
      mentions,
      { expires: Date.now() + 10 * 1e3 }
    );
  }
  async getCachedCookies(username) {
    return await this.runtime.cacheManager.get(
      `twitter/${username}/cookies`
    );
  }
  async cacheCookies(username, cookies) {
    await this.runtime.cacheManager.set(
      `twitter/${username}/cookies`,
      cookies
    );
  }
  async getCachedProfile(username) {
    return await this.runtime.cacheManager.get(
      `twitter/${username}/profile`
    );
  }
  async cacheProfile(profile) {
    await this.runtime.cacheManager.set(
      `twitter/${profile.username}/profile`,
      profile
    );
  }
  async fetchProfile(username) {
    const cached = await this.getCachedProfile(username);
    if (cached) return cached;
    try {
      const profile = await this.requestQueue.add(async () => {
        var _a;
        const profile2 = await this.twitterClient.getProfile(username);
        return {
          id: profile2.userId,
          username,
          screenName: profile2.name || this.runtime.character.name,
          bio: profile2.biography || typeof this.runtime.character.bio === "string" ? this.runtime.character.bio : this.runtime.character.bio.length > 0 ? this.runtime.character.bio[0] : "",
          nicknames: ((_a = this.runtime.character.twitterProfile) == null ? void 0 : _a.nicknames) || []
        };
      });
      this.cacheProfile(profile);
      return profile;
    } catch (error) {
      console.error("Error fetching Twitter profile:", error);
      return void 0;
    }
  }
};

// src/environment.ts
import { z } from "zod";
var DEFAULT_MAX_TWEET_LENGTH = 280;
var twitterEnvSchema = z.object({
  TWITTER_DRY_RUN: z.string().transform((val) => val.toLowerCase() === "true"),
  TWITTER_USERNAME: z.string().min(1, "Twitter username is required"),
  TWITTER_PASSWORD: z.string().min(1, "Twitter password is required"),
  TWITTER_EMAIL: z.string().email("Valid Twitter email is required"),
  TWITTER_COOKIES: z.string().optional(),
  MAX_TWEET_LENGTH: z.string().pipe(z.coerce.number().min(0).int()).default(DEFAULT_MAX_TWEET_LENGTH.toString())
});
async function validateTwitterConfig(runtime) {
  try {
    const twitterConfig = {
      TWITTER_DRY_RUN: runtime.getSetting("TWITTER_DRY_RUN") || process.env.TWITTER_DRY_RUN || "false",
      TWITTER_USERNAME: runtime.getSetting("TWITTER_USERNAME") || process.env.TWITTER_USERNAME,
      TWITTER_PASSWORD: runtime.getSetting("TWITTER_PASSWORD") || process.env.TWITTER_PASSWORD,
      TWITTER_EMAIL: runtime.getSetting("TWITTER_EMAIL") || process.env.TWITTER_EMAIL,
      TWITTER_COOKIES: runtime.getSetting("TWITTER_COOKIES") || process.env.TWITTER_COOKIES,
      MAX_TWEET_LENGTH: runtime.getSetting("MAX_TWEET_LENGTH") || process.env.MAX_TWEET_LENGTH || DEFAULT_MAX_TWEET_LENGTH.toString()
    };
    return twitterEnvSchema.parse(twitterConfig);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map((err) => `${err.path.join(".")}: ${err.message}`).join("\n");
      throw new Error(
        `Twitter configuration validation failed:
${errorMessages}`
      );
    }
    throw error;
  }
}

// src/interactions.ts
import { SearchMode as SearchMode2 } from "agent-twitter-client";
import {
  composeContext,
  generateMessageResponse,
  generateShouldRespond,
  messageCompletionFooter,
  shouldRespondFooter,
  ModelClass,
  stringToUuid as stringToUuid3,
  elizaLogger as elizaLogger3,
  getEmbeddingZeroVector as getEmbeddingZeroVector3
} from "@ai16z/eliza";

// src/utils.ts
import { getEmbeddingZeroVector as getEmbeddingZeroVector2 } from "@ai16z/eliza";
import { stringToUuid as stringToUuid2 } from "@ai16z/eliza";
import { elizaLogger as elizaLogger2 } from "@ai16z/eliza";
import fs from "fs";
import path from "path";
var wait = (minTime = 1e3, maxTime = 3e3) => {
  const waitTime = Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  return new Promise((resolve) => setTimeout(resolve, waitTime));
};
async function buildConversationThread(tweet, client, maxReplies = 10) {
  const thread = [];
  const visited = /* @__PURE__ */ new Set();
  async function processThread(currentTweet, depth = 0) {
    var _a;
    elizaLogger2.debug("Processing tweet:", {
      id: currentTweet.id,
      inReplyToStatusId: currentTweet.inReplyToStatusId,
      depth
    });
    if (!currentTweet) {
      elizaLogger2.debug("No current tweet found for thread building");
      return;
    }
    if (depth >= maxReplies) {
      elizaLogger2.debug("Reached maximum reply depth", depth);
      return;
    }
    const memory = await client.runtime.messageManager.getMemoryById(
      stringToUuid2(currentTweet.id + "-" + client.runtime.agentId)
    );
    if (!memory) {
      const roomId = stringToUuid2(
        currentTweet.conversationId + "-" + client.runtime.agentId
      );
      const userId = stringToUuid2(currentTweet.userId);
      await client.runtime.ensureConnection(
        userId,
        roomId,
        currentTweet.username,
        currentTweet.name,
        "twitter"
      );
      await client.runtime.messageManager.createMemory({
        id: stringToUuid2(
          currentTweet.id + "-" + client.runtime.agentId
        ),
        agentId: client.runtime.agentId,
        content: {
          text: currentTweet.text,
          source: "twitter",
          url: currentTweet.permanentUrl,
          inReplyTo: currentTweet.inReplyToStatusId ? stringToUuid2(
            currentTweet.inReplyToStatusId + "-" + client.runtime.agentId
          ) : void 0
        },
        createdAt: currentTweet.timestamp * 1e3,
        roomId,
        userId: currentTweet.userId === client.profile.id ? client.runtime.agentId : stringToUuid2(currentTweet.userId),
        embedding: getEmbeddingZeroVector2()
      });
    }
    if (visited.has(currentTweet.id)) {
      elizaLogger2.debug("Already visited tweet:", currentTweet.id);
      return;
    }
    visited.add(currentTweet.id);
    thread.unshift(currentTweet);
    elizaLogger2.debug("Current thread state:", {
      length: thread.length,
      currentDepth: depth,
      tweetId: currentTweet.id
    });
    if (currentTweet.inReplyToStatusId) {
      elizaLogger2.debug(
        "Fetching parent tweet:",
        currentTweet.inReplyToStatusId
      );
      try {
        const parentTweet = await client.twitterClient.getTweet(
          currentTweet.inReplyToStatusId
        );
        if (parentTweet) {
          elizaLogger2.debug("Found parent tweet:", {
            id: parentTweet.id,
            text: (_a = parentTweet.text) == null ? void 0 : _a.slice(0, 50)
          });
          await processThread(parentTweet, depth + 1);
        } else {
          elizaLogger2.debug(
            "No parent tweet found for:",
            currentTweet.inReplyToStatusId
          );
        }
      } catch (error) {
        elizaLogger2.error("Error fetching parent tweet:", {
          tweetId: currentTweet.inReplyToStatusId,
          error
        });
      }
    } else {
      elizaLogger2.debug(
        "Reached end of reply chain at:",
        currentTweet.id
      );
    }
  }
  await processThread(tweet, 0);
  elizaLogger2.debug("Final thread built:", {
    totalTweets: thread.length,
    tweetIds: thread.map((t) => {
      var _a;
      return {
        id: t.id,
        text: (_a = t.text) == null ? void 0 : _a.slice(0, 50)
      };
    })
  });
  return thread;
}
async function sendTweet(client, content, roomId, twitterUsername, inReplyTo) {
  var _a, _b, _c;
  const tweetChunks = splitTweetContent(
    content.text,
    Number(client.runtime.getSetting("MAX_TWEET_LENGTH")) || DEFAULT_MAX_TWEET_LENGTH
  );
  const sentTweets = [];
  let previousTweetId = inReplyTo;
  for (const chunk of tweetChunks) {
    let mediaData;
    if (content.attachments && content.attachments.length > 0) {
      mediaData = await Promise.all(
        content.attachments.map(async (attachment) => {
          if (/^(http|https):\/\//.test(attachment.url)) {
            const response = await fetch(attachment.url);
            if (!response.ok) {
              throw new Error(
                `Failed to fetch file: ${attachment.url}`
              );
            }
            const mediaBuffer = Buffer.from(
              await response.arrayBuffer()
            );
            const mediaType = attachment.contentType;
            return { data: mediaBuffer, mediaType };
          } else if (fs.existsSync(attachment.url)) {
            const mediaBuffer = await fs.promises.readFile(
              path.resolve(attachment.url)
            );
            const mediaType = attachment.contentType;
            return { data: mediaBuffer, mediaType };
          } else {
            throw new Error(
              `File not found: ${attachment.url}. Make sure the path is correct.`
            );
          }
        })
      );
    }
    const result = await client.requestQueue.add(
      async () => await client.twitterClient.sendTweet(
        chunk.trim(),
        previousTweetId,
        mediaData
      )
    );
    const body = await result.json();
    if ((_c = (_b = (_a = body == null ? void 0 : body.data) == null ? void 0 : _a.create_tweet) == null ? void 0 : _b.tweet_results) == null ? void 0 : _c.result) {
      const tweetResult = body.data.create_tweet.tweet_results.result;
      const finalTweet = {
        id: tweetResult.rest_id,
        text: tweetResult.legacy.full_text,
        conversationId: tweetResult.legacy.conversation_id_str,
        timestamp: new Date(tweetResult.legacy.created_at).getTime() / 1e3,
        userId: tweetResult.legacy.user_id_str,
        inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
        permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
        hashtags: [],
        mentions: [],
        photos: [],
        thread: [],
        urls: [],
        videos: []
      };
      sentTweets.push(finalTweet);
      previousTweetId = finalTweet.id;
    } else {
      console.error("Error sending chunk", chunk, "repsonse:", body);
    }
    await wait(1e3, 2e3);
  }
  const memories = sentTweets.map((tweet) => ({
    id: stringToUuid2(tweet.id + "-" + client.runtime.agentId),
    agentId: client.runtime.agentId,
    userId: client.runtime.agentId,
    content: {
      text: tweet.text,
      source: "twitter",
      url: tweet.permanentUrl,
      inReplyTo: tweet.inReplyToStatusId ? stringToUuid2(
        tweet.inReplyToStatusId + "-" + client.runtime.agentId
      ) : void 0
    },
    roomId,
    embedding: getEmbeddingZeroVector2(),
    createdAt: tweet.timestamp * 1e3
  }));
  return memories;
}
function splitTweetContent(content, maxLength) {
  const paragraphs = content.split("\n\n").map((p) => p.trim());
  const tweets = [];
  let currentTweet = "";
  for (const paragraph of paragraphs) {
    if (!paragraph) continue;
    if ((currentTweet + "\n\n" + paragraph).trim().length <= maxLength) {
      if (currentTweet) {
        currentTweet += "\n\n" + paragraph;
      } else {
        currentTweet = paragraph;
      }
    } else {
      if (currentTweet) {
        tweets.push(currentTweet.trim());
      }
      if (paragraph.length <= maxLength) {
        currentTweet = paragraph;
      } else {
        const chunks = splitParagraph(paragraph, maxLength);
        tweets.push(...chunks.slice(0, -1));
        currentTweet = chunks[chunks.length - 1];
      }
    }
  }
  if (currentTweet) {
    tweets.push(currentTweet.trim());
  }
  return tweets;
}
function splitParagraph(paragraph, maxLength) {
  const sentences = paragraph.match(/[^\.!\?]+[\.!\?]+|[^\.!\?]+$/g) || [
    paragraph
  ];
  const chunks = [];
  let currentChunk = "";
  for (const sentence of sentences) {
    if ((currentChunk + " " + sentence).trim().length <= maxLength) {
      if (currentChunk) {
        currentChunk += " " + sentence;
      } else {
        currentChunk = sentence;
      }
    } else {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      if (sentence.length <= maxLength) {
        currentChunk = sentence;
      } else {
        const words = sentence.split(" ");
        currentChunk = "";
        for (const word of words) {
          if ((currentChunk + " " + word).trim().length <= maxLength) {
            if (currentChunk) {
              currentChunk += " " + word;
            } else {
              currentChunk = word;
            }
          } else {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
            }
            currentChunk = word;
          }
        }
      }
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }
  return chunks;
}

// src/interactions.ts
var twitterMessageHandlerTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# Task: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}) while using the thread of tweets as additional context:
Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

{{actions}}
# Task: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}). You MUST include an action if the current post text includes a prompt that is similar to one of the available actions mentioned here:
{{actionNames}}
Here is the current post text again. Remember to include an action if the current post text includes a prompt that asks for one of the available actions mentioned above (does not need to be exact)
{{currentPost}}
` + messageCompletionFooter;
var twitterShouldRespondTemplate = (targetUsersStr) => `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

PRIORITY RULE: ALWAYS RESPOND to these users regardless of topic or message content: ${targetUsersStr}. Topic relevance should be ignored for these users.

For other users:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

{{recentPosts}}

IMPORTANT: For users not in the priority list, {{agentName}} (@{{twitterUserName}}) should err on the side of IGNORE rather than RESPOND if in doubt.

{{recentPosts}}

IMPORTANT: {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.

{{currentPost}}

Thread of Tweets You Are Replying To:

{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;
var TwitterInteractionClient = class {
  client;
  runtime;
  constructor(client, runtime) {
    this.client = client;
    this.runtime = runtime;
  }
  async start() {
    const handleTwitterInteractionsLoop = () => {
      this.handleTwitterInteractions();
      setTimeout(
        handleTwitterInteractionsLoop,
        Number(
          this.runtime.getSetting("TWITTER_POLL_INTERVAL") || 120
        ) * 1e3
        // Default to 2 minutes
      );
    };
    handleTwitterInteractionsLoop();
  }
  async handleTwitterInteractions() {
    var _a;
    elizaLogger3.log("Checking Twitter interactions");
    const targetUsersStr = this.runtime.getSetting("TWITTER_TARGET_USERS");
    const twitterUsername = this.client.profile.username;
    try {
      const mentionCandidates = (await this.client.fetchSearchTweets(
        `@${twitterUsername}`,
        20,
        SearchMode2.Latest
      )).tweets;
      elizaLogger3.log(
        "Completed checking mentioned tweets:",
        mentionCandidates.length
      );
      let uniqueTweetCandidates = [...mentionCandidates];
      if (targetUsersStr && targetUsersStr.trim()) {
        const TARGET_USERS = targetUsersStr.split(",").map((u) => u.trim()).filter((u) => u.length > 0);
        elizaLogger3.log("Processing target users:", TARGET_USERS);
        if (TARGET_USERS.length > 0) {
          const tweetsByUser = /* @__PURE__ */ new Map();
          for (const username of TARGET_USERS) {
            try {
              const userTweets = (await this.client.twitterClient.fetchSearchTweets(
                `from:${username}`,
                3,
                SearchMode2.Latest
              )).tweets;
              const validTweets = userTweets.filter((tweet) => {
                const isUnprocessed = !this.client.lastCheckedTweetId || parseInt(tweet.id) > this.client.lastCheckedTweetId;
                const isRecent = Date.now() - tweet.timestamp * 1e3 < 2 * 60 * 60 * 1e3;
                elizaLogger3.log(`Tweet ${tweet.id} checks:`, {
                  isUnprocessed,
                  isRecent,
                  isReply: tweet.isReply,
                  isRetweet: tweet.isRetweet
                });
                return isUnprocessed && !tweet.isReply && !tweet.isRetweet && isRecent;
              });
              if (validTweets.length > 0) {
                tweetsByUser.set(username, validTweets);
                elizaLogger3.log(
                  `Found ${validTweets.length} valid tweets from ${username}`
                );
              }
            } catch (error) {
              elizaLogger3.error(
                `Error fetching tweets for ${username}:`,
                error
              );
              continue;
            }
          }
          const selectedTweets = [];
          for (const [username, tweets] of tweetsByUser) {
            if (tweets.length > 0) {
              const randomTweet = tweets[Math.floor(Math.random() * tweets.length)];
              selectedTweets.push(randomTweet);
              elizaLogger3.log(
                `Selected tweet from ${username}: ${(_a = randomTweet.text) == null ? void 0 : _a.substring(0, 100)}`
              );
            }
          }
          uniqueTweetCandidates = [
            ...mentionCandidates,
            ...selectedTweets
          ];
        }
      } else {
        elizaLogger3.log(
          "No target users configured, processing only mentions"
        );
      }
      uniqueTweetCandidates.sort((a, b) => a.id.localeCompare(b.id)).filter((tweet) => tweet.userId !== this.client.profile.id);
      for (const tweet of uniqueTweetCandidates) {
        if (!this.client.lastCheckedTweetId || BigInt(tweet.id) > this.client.lastCheckedTweetId) {
          const tweetId = stringToUuid3(
            tweet.id + "-" + this.runtime.agentId
          );
          const existingResponse = await this.runtime.messageManager.getMemoryById(
            tweetId
          );
          if (existingResponse) {
            elizaLogger3.log(
              `Already responded to tweet ${tweet.id}, skipping`
            );
            continue;
          }
          elizaLogger3.log("New Tweet found", tweet.permanentUrl);
          const roomId = stringToUuid3(
            tweet.conversationId + "-" + this.runtime.agentId
          );
          const userIdUUID = tweet.userId === this.client.profile.id ? this.runtime.agentId : stringToUuid3(tweet.userId);
          await this.runtime.ensureConnection(
            userIdUUID,
            roomId,
            tweet.username,
            tweet.name,
            "twitter"
          );
          const thread = await buildConversationThread(
            tweet,
            this.client
          );
          const message = {
            content: { text: tweet.text },
            agentId: this.runtime.agentId,
            userId: userIdUUID,
            roomId
          };
          await this.handleTweet({
            tweet,
            message,
            thread
          });
          this.client.lastCheckedTweetId = BigInt(tweet.id);
        }
      }
      await this.client.cacheLatestCheckedTweetId();
      elizaLogger3.log("Finished checking Twitter interactions");
    } catch (error) {
      elizaLogger3.error("Error handling Twitter interactions:", error);
    }
  }
  async handleTweet({
    tweet,
    message,
    thread
  }) {
    var _a, _b, _c, _d, _e, _f;
    if (tweet.userId === this.client.profile.id) {
      return;
    }
    if (!message.content.text) {
      elizaLogger3.log("Skipping Tweet with no text", tweet.id);
      return { text: "", action: "IGNORE" };
    }
    elizaLogger3.log("Processing Tweet: ", tweet.id);
    const formatTweet = (tweet2) => {
      return `  ID: ${tweet2.id}
  From: ${tweet2.name} (@${tweet2.username})
  Text: ${tweet2.text}`;
    };
    const currentPost = formatTweet(tweet);
    elizaLogger3.debug("Thread: ", thread);
    const formattedConversation = thread.map(
      (tweet2) => `@${tweet2.username} (${new Date(
        tweet2.timestamp * 1e3
      ).toLocaleString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        month: "short",
        day: "numeric"
      })}):
        ${tweet2.text}`
    ).join("\n\n");
    elizaLogger3.debug("formattedConversation: ", formattedConversation);
    let state = await this.runtime.composeState(message, {
      twitterClient: this.client.twitterClient,
      twitterUserName: this.runtime.getSetting("TWITTER_USERNAME"),
      currentPost,
      formattedConversation
    });
    const tweetId = stringToUuid3(tweet.id + "-" + this.runtime.agentId);
    const tweetExists = await this.runtime.messageManager.getMemoryById(tweetId);
    if (!tweetExists) {
      elizaLogger3.log("tweet does not exist, saving");
      const userIdUUID = stringToUuid3(tweet.userId);
      const roomId = stringToUuid3(tweet.conversationId);
      const message2 = {
        id: tweetId,
        agentId: this.runtime.agentId,
        content: {
          text: tweet.text,
          url: tweet.permanentUrl,
          inReplyTo: tweet.inReplyToStatusId ? stringToUuid3(
            tweet.inReplyToStatusId + "-" + this.runtime.agentId
          ) : void 0
        },
        userId: userIdUUID,
        roomId,
        createdAt: tweet.timestamp * 1e3
      };
      this.client.saveRequestMessage(message2, state);
    }
    const targetUsersStr = this.runtime.getSetting("TWITTER_TARGET_USERS");
    const validTargetUsersStr = targetUsersStr && targetUsersStr.trim() ? targetUsersStr.split(",").map((u) => u.trim()).filter((u) => u.length > 0).join(",") : "";
    const shouldRespondContext = composeContext({
      state,
      template: ((_a = this.runtime.character.templates) == null ? void 0 : _a.twitterShouldRespondTemplate) || ((_c = (_b = this.runtime.character) == null ? void 0 : _b.templates) == null ? void 0 : _c.shouldRespondTemplate) || twitterShouldRespondTemplate(validTargetUsersStr)
    });
    const shouldRespond = await generateShouldRespond({
      runtime: this.runtime,
      context: shouldRespondContext,
      modelClass: ModelClass.MEDIUM
    });
    if (shouldRespond !== "RESPOND") {
      elizaLogger3.log("Not responding to message");
      return { text: "Response Decision:", action: shouldRespond };
    }
    const context = composeContext({
      state,
      template: ((_d = this.runtime.character.templates) == null ? void 0 : _d.twitterMessageHandlerTemplate) || ((_f = (_e = this.runtime.character) == null ? void 0 : _e.templates) == null ? void 0 : _f.messageHandlerTemplate) || twitterMessageHandlerTemplate
    });
    elizaLogger3.debug("Interactions prompt:\n" + context);
    const response = await generateMessageResponse({
      runtime: this.runtime,
      context,
      modelClass: ModelClass.LARGE
    });
    const removeQuotes = (str) => str.replace(/^['"](.*)['"]$/, "$1");
    const stringId = stringToUuid3(tweet.id + "-" + this.runtime.agentId);
    response.inReplyTo = stringId;
    response.text = removeQuotes(response.text);
    if (response.text) {
      try {
        const callback = async (response2) => {
          const memories = await sendTweet(
            this.client,
            response2,
            message.roomId,
            this.runtime.getSetting("TWITTER_USERNAME"),
            tweet.id
          );
          return memories;
        };
        const responseMessages = await callback(response);
        state = await this.runtime.updateRecentMessageState(
          state
        );
        for (const responseMessage of responseMessages) {
          if (responseMessage === responseMessages[responseMessages.length - 1]) {
            responseMessage.content.action = response.action;
          } else {
            responseMessage.content.action = "CONTINUE";
          }
          await this.runtime.messageManager.createMemory(
            responseMessage
          );
        }
        await this.runtime.processActions(
          message,
          responseMessages,
          state,
          callback
        );
        const responseInfo = `Context:

${context}

Selected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}
Agent's Output:
${response.text}`;
        await this.runtime.cacheManager.set(
          `twitter/tweet_generation_${tweet.id}.txt`,
          responseInfo
        );
        await wait();
      } catch (error) {
        elizaLogger3.error(`Error sending response tweet: ${error}`);
      }
    }
  }
  async buildConversationThread(tweet, maxReplies = 10) {
    const thread = [];
    const visited = /* @__PURE__ */ new Set();
    async function processThread(currentTweet, depth = 0) {
      var _a;
      elizaLogger3.log("Processing tweet:", {
        id: currentTweet.id,
        inReplyToStatusId: currentTweet.inReplyToStatusId,
        depth
      });
      if (!currentTweet) {
        elizaLogger3.log("No current tweet found for thread building");
        return;
      }
      if (depth >= maxReplies) {
        elizaLogger3.log("Reached maximum reply depth", depth);
        return;
      }
      const memory = await this.runtime.messageManager.getMemoryById(
        stringToUuid3(currentTweet.id + "-" + this.runtime.agentId)
      );
      if (!memory) {
        const roomId = stringToUuid3(
          currentTweet.conversationId + "-" + this.runtime.agentId
        );
        const userId = stringToUuid3(currentTweet.userId);
        await this.runtime.ensureConnection(
          userId,
          roomId,
          currentTweet.username,
          currentTweet.name,
          "twitter"
        );
        this.runtime.messageManager.createMemory({
          id: stringToUuid3(
            currentTweet.id + "-" + this.runtime.agentId
          ),
          agentId: this.runtime.agentId,
          content: {
            text: currentTweet.text,
            source: "twitter",
            url: currentTweet.permanentUrl,
            inReplyTo: currentTweet.inReplyToStatusId ? stringToUuid3(
              currentTweet.inReplyToStatusId + "-" + this.runtime.agentId
            ) : void 0
          },
          createdAt: currentTweet.timestamp * 1e3,
          roomId,
          userId: currentTweet.userId === this.twitterUserId ? this.runtime.agentId : stringToUuid3(currentTweet.userId),
          embedding: getEmbeddingZeroVector3()
        });
      }
      if (visited.has(currentTweet.id)) {
        elizaLogger3.log("Already visited tweet:", currentTweet.id);
        return;
      }
      visited.add(currentTweet.id);
      thread.unshift(currentTweet);
      elizaLogger3.debug("Current thread state:", {
        length: thread.length,
        currentDepth: depth,
        tweetId: currentTweet.id
      });
      if (currentTweet.inReplyToStatusId) {
        elizaLogger3.log(
          "Fetching parent tweet:",
          currentTweet.inReplyToStatusId
        );
        try {
          const parentTweet = await this.twitterClient.getTweet(
            currentTweet.inReplyToStatusId
          );
          if (parentTweet) {
            elizaLogger3.log("Found parent tweet:", {
              id: parentTweet.id,
              text: (_a = parentTweet.text) == null ? void 0 : _a.slice(0, 50)
            });
            await processThread(parentTweet, depth + 1);
          } else {
            elizaLogger3.log(
              "No parent tweet found for:",
              currentTweet.inReplyToStatusId
            );
          }
        } catch (error) {
          elizaLogger3.log("Error fetching parent tweet:", {
            tweetId: currentTweet.inReplyToStatusId,
            error
          });
        }
      } else {
        elizaLogger3.log(
          "Reached end of reply chain at:",
          currentTweet.id
        );
      }
    }
    await processThread.bind(this)(tweet, 0);
    elizaLogger3.debug("Final thread built:", {
      totalTweets: thread.length,
      tweetIds: thread.map((t) => {
        var _a;
        return {
          id: t.id,
          text: (_a = t.text) == null ? void 0 : _a.slice(0, 50)
        };
      })
    });
    return thread;
  }
};

// src/post.ts
import {
  composeContext as composeContext2,
  generateText,
  getEmbeddingZeroVector as getEmbeddingZeroVector4,
  ModelClass as ModelClass2,
  stringToUuid as stringToUuid4,
  parseBooleanFromText
} from "@ai16z/eliza";
import { elizaLogger as elizaLogger4 } from "@ai16z/eliza";
import { postActionResponseFooter } from "@ai16z/eliza";
import { generateTweetActions } from "@ai16z/eliza";
import { ServiceType } from "@ai16z/eliza";
var twitterPostTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a post in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.
Write a post that is {{adjective}} about {{topic}}, from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
Your response should be 1, 2, or 3 sentences (choose the length at random).
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than {{maxTweetLength}}. No emojis. Use \\n\\n (double spaces) between statements if there are multiple statements in your response.`;
var twitterActionTemplate = `
# INSTRUCTIONS: Determine actions for {{agentName}} (@{{twitterUserName}}) based on:
{{bio}}
{{postDirections}}

Guidelines:
- Highly selective engagement
- Direct mentions are priority
- Skip: low-effort content, off-topic, repetitive

Actions (respond only with tags):
[LIKE] - Resonates with interests (9.5/10)
[RETWEET] - Perfect character alignment (9/10)
[QUOTE] - Can add unique value (8/10)
[REPLY] - Memetic opportunity (9/10)

Tweet:
{{currentTweet}}

# Respond with qualifying action tags only.` + postActionResponseFooter;
var MAX_TWEET_LENGTH = 240;
function truncateToCompleteSentence(text, maxTweetLength) {
  if (text.length <= maxTweetLength) {
    return text;
  }
  const truncatedAtPeriod = text.slice(
    0,
    text.lastIndexOf(".", maxTweetLength) + 1
  );
  if (truncatedAtPeriod.trim().length > 0) {
    return truncatedAtPeriod.trim();
  }
  const truncatedAtSpace = text.slice(
    0,
    text.lastIndexOf(" ", maxTweetLength)
  );
  if (truncatedAtSpace.trim().length > 0) {
    return truncatedAtSpace.trim() + "...";
  }
  return text.slice(0, maxTweetLength - 3).trim() + "...";
}
var TwitterPostClient = class {
  client;
  runtime;
  twitterUsername;
  isProcessing = false;
  lastProcessTime = 0;
  stopProcessingActions = false;
  async start(postImmediately = false) {
    if (!this.client.profile) {
      await this.client.init();
    }
    const generateNewTweetLoop = async () => {
      const lastPost = await this.runtime.cacheManager.get("twitter/" + this.twitterUsername + "/lastPost");
      const lastPostTimestamp = (lastPost == null ? void 0 : lastPost.timestamp) ?? 0;
      const minMinutes = parseInt(this.runtime.getSetting("POST_INTERVAL_MIN")) || 90;
      const maxMinutes = parseInt(this.runtime.getSetting("POST_INTERVAL_MAX")) || 180;
      const randomMinutes = Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
      const delay = randomMinutes * 60 * 1e3;
      if (Date.now() > lastPostTimestamp + delay) {
        await this.generateNewTweet();
      }
      setTimeout(() => {
        generateNewTweetLoop();
      }, delay);
      elizaLogger4.log(`Next tweet scheduled in ${randomMinutes} minutes`);
    };
    const processActionsLoop = async () => {
      const actionInterval = parseInt(this.runtime.getSetting("ACTION_INTERVAL")) || 3e5;
      while (!this.stopProcessingActions) {
        try {
          const results = await this.processTweetActions();
          if (results) {
            elizaLogger4.log(`Processed ${results.length} tweets`);
            elizaLogger4.log(
              `Next action processing scheduled in ${actionInterval / 1e3} seconds`
            );
            await new Promise(
              (resolve) => setTimeout(resolve, actionInterval)
            );
          }
        } catch (error) {
          elizaLogger4.error(
            "Error in action processing loop:",
            error
          );
          await new Promise((resolve) => setTimeout(resolve, 3e4));
        }
      }
    };
    if (this.runtime.getSetting("POST_IMMEDIATELY") != null && this.runtime.getSetting("POST_IMMEDIATELY") != "") {
      postImmediately = parseBooleanFromText(
        this.runtime.getSetting("POST_IMMEDIATELY")
      );
    }
    if (postImmediately) {
      await this.generateNewTweet();
    }
    generateNewTweetLoop();
    const enableActionProcessing = this.runtime.getSetting("ENABLE_ACTION_PROCESSING") ?? false;
    if (enableActionProcessing) {
      processActionsLoop().catch((error) => {
        elizaLogger4.error(
          "Fatal error in process actions loop:",
          error
        );
      });
    } else {
      elizaLogger4.log("Action processing loop disabled by configuration");
    }
    generateNewTweetLoop();
  }
  constructor(client, runtime) {
    this.client = client;
    this.runtime = runtime;
    this.twitterUsername = runtime.getSetting("TWITTER_USERNAME");
  }
  async generateNewTweet(taskPrompt = "") {
    var _a, _b, _c, _d;
    elizaLogger4.log("Generating new tweet");
    try {
      const roomId = stringToUuid4(
        "twitter_generate_room-" + this.client.profile.username
      );
      await this.runtime.ensureUserExists(
        this.runtime.agentId,
        this.client.profile.username,
        this.runtime.character.name,
        "twitter"
      );
      const topics = taskPrompt || this.runtime.character.topics.join(", ");
      const state = await this.runtime.composeState(
        {
          userId: this.runtime.agentId,
          roomId,
          agentId: this.runtime.agentId,
          content: {
            text: topics,
            action: "TWEET"
          }
        },
        {
          twitterUserName: this.client.profile.username
        }
      );
      const context = composeContext2({
        state,
        template: ((_a = this.runtime.character.templates) == null ? void 0 : _a.twitterPostTemplate) || twitterPostTemplate
      });
      console.log("twitter context:\n" + context);
      elizaLogger4.debug("generate post prompt:\n" + context);
      const newTweetContent = await generateText({
        runtime: this.runtime,
        context,
        modelClass: ModelClass2.SMALL
      });
      let cleanedContent = "";
      try {
        const parsedResponse = JSON.parse(newTweetContent);
        if (parsedResponse.text) {
          cleanedContent = parsedResponse.text;
        } else if (typeof parsedResponse === "string") {
          cleanedContent = parsedResponse;
        }
      } catch (error) {
        error.linted = true;
        cleanedContent = newTweetContent.replace(/^\s*{?\s*"text":\s*"|"\s*}?\s*$/g, "").replace(/^['"](.*)['"]$/g, "$1").replace(/\\"/g, '"').replace(/\\n/g, "\n").trim();
      }
      if (!cleanedContent) {
        elizaLogger4.error(
          "Failed to extract valid content from response:",
          {
            rawResponse: newTweetContent,
            attempted: "JSON parsing"
          }
        );
        return;
      }
      const content = truncateToCompleteSentence(
        cleanedContent,
        MAX_TWEET_LENGTH
      );
      const removeQuotes = (str) => str.replace(/^['"](.*)['"]$/, "$1");
      const fixNewLines = (str) => str.replaceAll(/\\n/g, "\n");
      cleanedContent = removeQuotes(fixNewLines(content));
      if (this.runtime.getSetting("TWITTER_DRY_RUN") === "true") {
        elizaLogger4.info(
          `Dry run: would have posted tweet: ${cleanedContent}`
        );
        return;
      }
      try {
        elizaLogger4.log(`Posting new tweet:
 ${cleanedContent}`);
        const result = await this.client.requestQueue.add(
          async () => await this.client.twitterClient.sendTweet(
            cleanedContent
          )
        );
        const body = await result.json();
        if (!((_d = (_c = (_b = body == null ? void 0 : body.data) == null ? void 0 : _b.create_tweet) == null ? void 0 : _c.tweet_results) == null ? void 0 : _d.result)) {
          console.error("Error sending tweet; Bad response:", body);
          return;
        }
        const tweetResult = body.data.create_tweet.tweet_results.result;
        const tweet = {
          id: tweetResult.rest_id,
          name: this.client.profile.screenName,
          username: this.client.profile.username,
          text: tweetResult.legacy.full_text,
          conversationId: tweetResult.legacy.conversation_id_str,
          createdAt: tweetResult.legacy.created_at,
          timestamp: new Date(
            tweetResult.legacy.created_at
          ).getTime(),
          userId: this.client.profile.id,
          inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
          permanentUrl: `https://twitter.com/${this.twitterUsername}/status/${tweetResult.rest_id}`,
          hashtags: [],
          mentions: [],
          photos: [],
          thread: [],
          urls: [],
          videos: []
        };
        await this.runtime.cacheManager.set(
          `twitter/${this.client.profile.username}/lastPost`,
          {
            id: tweet.id,
            timestamp: Date.now()
          }
        );
        await this.client.cacheTweet(tweet);
        elizaLogger4.log(`Tweet posted:
 ${tweet.permanentUrl}`);
        await this.runtime.ensureRoomExists(roomId);
        await this.runtime.ensureParticipantInRoom(
          this.runtime.agentId,
          roomId
        );
        await this.runtime.messageManager.createMemory({
          id: stringToUuid4(tweet.id + "-" + this.runtime.agentId),
          userId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          content: {
            text: newTweetContent.trim(),
            url: tweet.permanentUrl,
            source: "twitter"
          },
          roomId,
          embedding: getEmbeddingZeroVector4(),
          createdAt: tweet.timestamp
        });
      } catch (error) {
        elizaLogger4.error("Error sending tweet:", error);
      }
    } catch (error) {
      elizaLogger4.error("Error generating new tweet:", error);
    }
  }
  async generateTweetContent(tweetState, options) {
    var _a;
    const context = composeContext2({
      state: tweetState,
      template: (options == null ? void 0 : options.template) || ((_a = this.runtime.character.templates) == null ? void 0 : _a.twitterPostTemplate) || twitterPostTemplate
    });
    const response = await generateText({
      runtime: this.runtime,
      context: (options == null ? void 0 : options.context) || context,
      modelClass: ModelClass2.SMALL
    });
    console.log("generate tweet content response:\n" + response);
    const cleanedResponse = response.replace(/```json\s*/g, "").replace(/```\s*/g, "").replaceAll(/\\n/g, "\n").trim();
    try {
      const jsonResponse = JSON.parse(cleanedResponse);
      if (jsonResponse.text) {
        return this.trimTweetLength(jsonResponse.text);
      }
      if (typeof jsonResponse === "object") {
        const possibleContent = jsonResponse.content || jsonResponse.message || jsonResponse.response;
        if (possibleContent) {
          return this.trimTweetLength(possibleContent);
        }
      }
    } catch (error) {
      error.linted = true;
      elizaLogger4.debug("Response is not JSON, treating as plain text");
    }
    return this.trimTweetLength(cleanedResponse);
  }
  // Helper method to ensure tweet length compliance
  trimTweetLength(text, maxLength = 280) {
    if (text.length <= maxLength) return text;
    const lastSentence = text.slice(0, maxLength).lastIndexOf(".");
    if (lastSentence > 0) {
      return text.slice(0, lastSentence + 1).trim();
    }
    return text.slice(0, text.lastIndexOf(" ", maxLength - 3)).trim() + "...";
  }
  async processTweetActions() {
    var _a, _b, _c, _d, _e, _f;
    if (this.isProcessing) {
      elizaLogger4.log("Already processing tweet actions, skipping");
      return null;
    }
    try {
      this.isProcessing = true;
      this.lastProcessTime = Date.now();
      elizaLogger4.log("Processing tweet actions");
      await this.runtime.ensureUserExists(
        this.runtime.agentId,
        this.twitterUsername,
        this.runtime.character.name,
        "twitter"
      );
      const homeTimeline = await this.client.fetchTimelineForActions(15);
      const results = [];
      for (const tweet of homeTimeline) {
        try {
          const memory = await this.runtime.messageManager.getMemoryById(
            stringToUuid4(tweet.id + "-" + this.runtime.agentId)
          );
          if (memory) {
            elizaLogger4.log(
              `Already processed tweet ID: ${tweet.id}`
            );
            continue;
          }
          const roomId = stringToUuid4(
            tweet.conversationId + "-" + this.runtime.agentId
          );
          const tweetState = await this.runtime.composeState(
            {
              userId: this.runtime.agentId,
              roomId,
              agentId: this.runtime.agentId,
              content: { text: "", action: "" }
            },
            {
              twitterUserName: this.twitterUsername,
              currentTweet: `ID: ${tweet.id}
From: ${tweet.name} (@${tweet.username})
Text: ${tweet.text}`
            }
          );
          const actionContext = composeContext2({
            state: tweetState,
            template: ((_a = this.runtime.character.templates) == null ? void 0 : _a.twitterActionTemplate) || twitterActionTemplate
          });
          const actionResponse = await generateTweetActions({
            runtime: this.runtime,
            context: actionContext,
            modelClass: ModelClass2.SMALL
          });
          if (!actionResponse) {
            elizaLogger4.log(
              `No valid actions generated for tweet ${tweet.id}`
            );
            continue;
          }
          const executedActions = [];
          if (actionResponse.like) {
            try {
              await this.client.twitterClient.likeTweet(tweet.id);
              executedActions.push("like");
              elizaLogger4.log(`Liked tweet ${tweet.id}`);
            } catch (error) {
              elizaLogger4.error(
                `Error liking tweet ${tweet.id}:`,
                error
              );
            }
          }
          if (actionResponse.retweet) {
            try {
              await this.client.twitterClient.retweet(tweet.id);
              executedActions.push("retweet");
              elizaLogger4.log(`Retweeted tweet ${tweet.id}`);
            } catch (error) {
              elizaLogger4.error(
                `Error retweeting tweet ${tweet.id}:`,
                error
              );
            }
          }
          if (actionResponse.quote) {
            try {
              const thread = await buildConversationThread(
                tweet,
                this.client
              );
              const formattedConversation = thread.map(
                (t) => `@${t.username} (${new Date(t.timestamp * 1e3).toLocaleString()}): ${t.text}`
              ).join("\n\n");
              const imageDescriptions = [];
              if (((_b = tweet.photos) == null ? void 0 : _b.length) > 0) {
                elizaLogger4.log(
                  "Processing images in tweet for context"
                );
                for (const photo of tweet.photos) {
                  const description = await this.runtime.getService(
                    ServiceType.IMAGE_DESCRIPTION
                  ).describeImage(photo.url);
                  imageDescriptions.push(description);
                }
              }
              let quotedContent = "";
              if (tweet.quotedStatusId) {
                try {
                  const quotedTweet = await this.client.twitterClient.getTweet(
                    tweet.quotedStatusId
                  );
                  if (quotedTweet) {
                    quotedContent = `
Quoted Tweet from @${quotedTweet.username}:
${quotedTweet.text}`;
                  }
                } catch (error) {
                  elizaLogger4.error(
                    "Error fetching quoted tweet:",
                    error
                  );
                }
              }
              const enrichedState = await this.runtime.composeState(
                {
                  userId: this.runtime.agentId,
                  roomId: stringToUuid4(
                    tweet.conversationId + "-" + this.runtime.agentId
                  ),
                  agentId: this.runtime.agentId,
                  content: {
                    text: tweet.text,
                    action: "QUOTE"
                  }
                },
                {
                  twitterUserName: this.twitterUsername,
                  currentPost: `From @${tweet.username}: ${tweet.text}`,
                  formattedConversation,
                  imageContext: imageDescriptions.length > 0 ? `
Images in Tweet:
${imageDescriptions.map((desc, i) => `Image ${i + 1}: ${desc}`).join("\n")}` : "",
                  quotedContent
                }
              );
              const quoteContent = await this.generateTweetContent(enrichedState, {
                template: ((_c = this.runtime.character.templates) == null ? void 0 : _c.twitterMessageHandlerTemplate) || twitterMessageHandlerTemplate
              });
              if (!quoteContent) {
                elizaLogger4.error(
                  "Failed to generate valid quote tweet content"
                );
                return;
              }
              elizaLogger4.log(
                "Generated quote tweet content:",
                quoteContent
              );
              const result = await this.client.requestQueue.add(
                async () => await this.client.twitterClient.sendQuoteTweet(
                  quoteContent,
                  tweet.id
                )
              );
              const body = await result.json();
              if ((_f = (_e = (_d = body == null ? void 0 : body.data) == null ? void 0 : _d.create_tweet) == null ? void 0 : _e.tweet_results) == null ? void 0 : _f.result) {
                elizaLogger4.log(
                  "Successfully posted quote tweet"
                );
                executedActions.push("quote");
                await this.runtime.cacheManager.set(
                  `twitter/quote_generation_${tweet.id}.txt`,
                  `Context:
${enrichedState}

Generated Quote:
${quoteContent}`
                );
              } else {
                elizaLogger4.error(
                  "Quote tweet creation failed:",
                  body
                );
              }
            } catch (error) {
              elizaLogger4.error(
                "Error in quote tweet generation:",
                error
              );
            }
          }
          if (actionResponse.reply) {
            try {
              await this.handleTextOnlyReply(
                tweet,
                tweetState,
                executedActions
              );
            } catch (error) {
              elizaLogger4.error(
                `Error replying to tweet ${tweet.id}:`,
                error
              );
            }
          }
          await this.runtime.ensureRoomExists(roomId);
          await this.runtime.ensureUserExists(
            stringToUuid4(tweet.userId),
            tweet.username,
            tweet.name,
            "twitter"
          );
          await this.runtime.ensureParticipantInRoom(
            this.runtime.agentId,
            roomId
          );
          await this.runtime.messageManager.createMemory({
            id: stringToUuid4(tweet.id + "-" + this.runtime.agentId),
            userId: stringToUuid4(tweet.userId),
            content: {
              text: tweet.text,
              url: tweet.permanentUrl,
              source: "twitter",
              action: executedActions.join(",")
            },
            agentId: this.runtime.agentId,
            roomId,
            embedding: getEmbeddingZeroVector4(),
            createdAt: tweet.timestamp * 1e3
          });
          results.push({
            tweetId: tweet.id,
            parsedActions: actionResponse,
            executedActions
          });
        } catch (error) {
          elizaLogger4.error(
            `Error processing tweet ${tweet.id}:`,
            error
          );
          continue;
        }
      }
      return results;
    } catch (error) {
      elizaLogger4.error("Error in processTweetActions:", error);
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }
  async handleTextOnlyReply(tweet, tweetState, executedActions) {
    var _a, _b, _c, _d, _e;
    try {
      const thread = await buildConversationThread(tweet, this.client);
      const formattedConversation = thread.map(
        (t) => `@${t.username} (${new Date(t.timestamp * 1e3).toLocaleString()}): ${t.text}`
      ).join("\n\n");
      const imageDescriptions = [];
      if (((_a = tweet.photos) == null ? void 0 : _a.length) > 0) {
        elizaLogger4.log("Processing images in tweet for context");
        for (const photo of tweet.photos) {
          const description = await this.runtime.getService(
            ServiceType.IMAGE_DESCRIPTION
          ).describeImage(photo.url);
          imageDescriptions.push(description);
        }
      }
      let quotedContent = "";
      if (tweet.quotedStatusId) {
        try {
          const quotedTweet = await this.client.twitterClient.getTweet(
            tweet.quotedStatusId
          );
          if (quotedTweet) {
            quotedContent = `
Quoted Tweet from @${quotedTweet.username}:
${quotedTweet.text}`;
          }
        } catch (error) {
          elizaLogger4.error("Error fetching quoted tweet:", error);
        }
      }
      const enrichedState = await this.runtime.composeState(
        {
          userId: this.runtime.agentId,
          roomId: stringToUuid4(
            tweet.conversationId + "-" + this.runtime.agentId
          ),
          agentId: this.runtime.agentId,
          content: { text: tweet.text, action: "" }
        },
        {
          twitterUserName: this.twitterUsername,
          currentPost: `From @${tweet.username}: ${tweet.text}`,
          formattedConversation,
          imageContext: imageDescriptions.length > 0 ? `
Images in Tweet:
${imageDescriptions.map((desc, i) => `Image ${i + 1}: ${desc}`).join("\n")}` : "",
          quotedContent
        }
      );
      const replyText = await this.generateTweetContent(enrichedState, {
        template: ((_b = this.runtime.character.templates) == null ? void 0 : _b.twitterMessageHandlerTemplate) || twitterMessageHandlerTemplate
      });
      if (!replyText) {
        elizaLogger4.error("Failed to generate valid reply content");
        return;
      }
      elizaLogger4.debug("Final reply text to be sent:", replyText);
      const result = await this.client.requestQueue.add(
        async () => await this.client.twitterClient.sendTweet(
          replyText,
          tweet.id
        )
      );
      const body = await result.json();
      if ((_e = (_d = (_c = body == null ? void 0 : body.data) == null ? void 0 : _c.create_tweet) == null ? void 0 : _d.tweet_results) == null ? void 0 : _e.result) {
        elizaLogger4.log("Successfully posted reply tweet");
        executedActions.push("reply");
        await this.runtime.cacheManager.set(
          `twitter/reply_generation_${tweet.id}.txt`,
          `Context:
${enrichedState}

Generated Reply:
${replyText}`
        );
      } else {
        elizaLogger4.error("Tweet reply creation failed:", body);
      }
    } catch (error) {
      elizaLogger4.error("Error in handleTextOnlyReply:", error);
    }
  }
  async stop() {
    this.stopProcessingActions = true;
  }
};

// src/index.ts
var AgentHubManager = class {
  client;
  post;
  interaction;
  constructor(runtime, enableSearch) {
    this.client = new ClientBase(runtime);
    this.post = new TwitterPostClient(this.client, runtime);
    this.interaction = new TwitterInteractionClient(this.client, runtime);
  }
};
var AgentHubClientInterface = {
  async start(runtime) {
    await validateTwitterConfig(runtime);
    elizaLogger5.log("Twitter client started");
    const manager = new AgentHubManager(runtime, this.enableSearch);
    await manager.client.init();
    await manager.post.start();
    await manager.interaction.start();
    return manager;
  },
  async stop(_runtime) {
    elizaLogger5.warn("Twitter client does not support stopping yet");
  }
};
var index_default = AgentHubManager;
export {
  AgentHubClientInterface,
  index_default as default
};
//# sourceMappingURL=index.js.map