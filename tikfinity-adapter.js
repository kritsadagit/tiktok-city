function normalizeGiftMessage(message) {
  if (!message || message.event !== "gift") return null;
  const data = message.data || {};
  const giftInfo =
    data.gift ||
    data.giftDetails ||
    data.giftInfo ||
    data.extendedGiftInfo ||
    {};
  const giftName =
    data.giftName ||
    data.gift_name ||
    giftInfo.giftName ||
    giftInfo.name ||
    data.name;
  if (!giftName) return null;

  const giftType = Number(
    data.giftType ?? giftInfo.giftType ?? giftInfo.type ?? data.gift_type,
  );
  const repeatEnd = data.repeatEnd ?? data.repeat_end;
  // Streakable gifts send cumulative intermediate updates and a final frame.
  if (giftType === 1 && !(repeatEnd === true || repeatEnd === 1)) return null;

  const sender = data.user || data;
  const username =
    sender.nickname ||
    sender.displayId ||
    sender.uniqueId ||
    sender.username ||
    data.nickname ||
    data.displayId ||
    data.uniqueId ||
    "ผู้ชม";
  const rawCount = Number(data.repeatCount ?? data.repeat_count);
  const giftCount = Number.isFinite(rawCount)
    ? Math.max(1, Math.min(1000, Math.floor(rawCount)))
    : 1;
  const totalDiamonds = Number(
    data.totalDiamonds ?? data.totalCoins ?? data.total_coins,
  );
  const coinsField = Number(data.coins);
  const diamondCount = Number(
    data.diamondCount ??
      data.diamond_count ??
      giftInfo.diamondCount ??
      giftInfo.diamond_count,
  );
  const diamonds =
    Number.isFinite(totalDiamonds) && totalDiamonds > 0
      ? totalDiamonds
      : Number.isFinite(diamondCount) && diamondCount > 0
        ? diamondCount * giftCount
        : Number.isFinite(coinsField) && coinsField > 0
          ? coinsField
          : undefined;
  const eventId =
    data.eventId ||
    data.msgId ||
    data.messageId ||
    data.event_id ||
    data.transactionId ||
    data.common?.msgId;
  return { username, giftName, giftCount, diamonds, eventId };
}

module.exports = { normalizeGiftMessage };
