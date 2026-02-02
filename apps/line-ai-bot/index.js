import express from "express";
import line from "linebot";
import OpenAI from "openai";
import { getEnv } from "./lib/env.js";

const bot = line({
  channelId: getEnv("LINE_CHANNEL_ID"),
  channelSecret: getEnv("LINE_CHANNEL_SECRET"),
  channelAccessToken: getEnv("LINE_CHANNEL_ACCESS_TOKEN"),
});

const openai = new OpenAI({ apiKey: getEnv("OPENAI_API_KEY") });

bot.on("message", async (event) => {
  if (event.message.type !== "text") return;
  const userText = event.message.text;

  const response = await openai.chat.completions.create({
    model: getEnv("OPENAI_CHAT_MODEL") || getEnv("OPENAI_MODEL") || "gpt-5",
    messages: [{ role: "user", content: userText }],
  });

  const replyText = response.choices[0].message.content;
  await event.reply(replyText);
});

export default bot.parser();
