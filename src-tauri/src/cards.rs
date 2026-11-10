//! Flashcards. Cards are blocks written in pages (a front and a back); this
//! collects them and keeps each card's spaced-repetition progress. The
//! schedule itself is worked out by the UI, which shows the intervals on the
//! answer buttons; this side only checks and stores the result.

use crate::db::{fail, now, Db, Result};
use crate::planner::check_date;
use crate::organize::block_text;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    /// Next due date ("YYYY-MM-DD").
    pub due: String,
    /// Days until the next review (0 = again today).
    pub interval: i64,
    pub ease: f64,
    /// Successful reviews in a row.
    pub reps: i64,
    /// Times it was forgotten after being learned.
    pub lapses: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub page_id: String,
    pub id: String,
    /// Plain text of each side (links read as their titles).
    pub front: String,
    pub back: String,
    /// Each side's inline content as the editor stores it (text with its
    /// marks, line breaks and links), so studying shows the formatting.
    pub front_content: Value,
    pub back_content: Value,
    /// None until it's first studied.
    pub review: Option<Review>,
}

/// A page's cards, counted. This is all the sidebar, title bar and course
/// pages need; the cards themselves are only read when studying.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Deck {
    pub page_id: String,
    /// Cards with something on the front.
    pub count: usize,
    /// Studied before and due by today.
    pub due: usize,
    /// Never studied.
    pub fresh: usize,
    /// Learned well enough to be shown three weeks apart.
    pub mastered: usize,
}

const MASTERED_DAYS: i64 = 21;

/// Visits every flashcard block in document order.
fn walk_cards(node: &Value, f: &mut dyn FnMut(&Value)) {
    if node.get("type").and_then(Value::as_str) == Some("flashcard") {
        f(node);
        return;
    }
    for child in node.get("content").and_then(Value::as_array).into_iter().flatten() {
        walk_cards(child, f);
    }
}

/// A page's cards as `[id, front, back]`, kept with the page when it's saved.
pub(crate) fn derive_cards(doc: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    walk_cards(doc, &mut |card| {
        let Some(id) = card.pointer("/attrs/id").and_then(Value::as_str) else { return };
        let side = |i: usize| card.pointer(&format!("/content/{i}")).cloned().unwrap_or(Value::Null);
        out.push(Value::Array(vec![id.into(), side(0), side(1)]));
    });
    out
}

type CardRows = (Vec<(String, String)>, HashMap<(String, String), Review>);

impl Db {
    /// Live pages' `cards` or `card_ids` lists (most recently edited first),
    /// and every review.
    fn card_rows(&self, column: &'static str) -> Result<CardRows> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT p.id, d.{column} FROM page_derived d JOIN pages p ON p.rid = d.rid
             WHERE p.deleted_at IS NULL AND d.{column} != '[]'
             ORDER BY p.updated_at DESC"
        ))?;
        let pages: Vec<(String, String)> =
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        let mut stmt = conn.prepare("SELECT page_id, card_id, due, interval, ease, reps, lapses FROM card_reviews")?;
        let reviews: HashMap<(String, String), Review> = stmt
            .query_map([], |r| {
                Ok((
                    (r.get(0)?, r.get(1)?),
                    Review { due: r.get(2)?, interval: r.get(3)?, ease: r.get(4)?, reps: r.get(5)?, lapses: r.get(6)? },
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok((pages, reviews))
    }

    /// Every page with cards, counted for `today`.
    pub fn list_decks(&self, today: &str) -> Result<Vec<Deck>> {
        check_date(&Some(today.to_string()))?;
        // Only ids are read: which cards count was settled when each page was saved.
        let (pages, reviews) = self.card_rows("card_ids")?;
        let mut out = Vec::new();
        for (page_id, raw) in pages {
            let Ok(ids) = serde_json::from_str::<Vec<String>>(&raw) else { continue };
            let mut deck = Deck { page_id, count: 0, due: 0, fresh: 0, mastered: 0 };
            for id in ids {
                deck.count += 1;
                match reviews.get(&(deck.page_id.clone(), id)) {
                    None => deck.fresh += 1,
                    Some(r) => {
                        deck.due += usize::from(r.due.as_str() <= today);
                        deck.mastered += usize::from(r.interval >= MASTERED_DAYS);
                    }
                }
            }
            if deck.count > 0 {
                out.push(deck);
            }
        }
        Ok(out)
    }

    /// Every card in live pages that has something on its front.
    pub fn list_cards(&self) -> Result<Vec<Card>> {
        let titles = self.titles()?;
        let (pages, reviews) = self.card_rows("cards")?;
        let mut out = Vec::new();
        for (page_id, raw) in pages {
            let Ok(list) = serde_json::from_str::<Vec<(String, Value, Value)>>(&raw) else { continue };
            for (id, front_side, back_side) in list {
                let front = block_text(Some(&front_side), Some(&titles));
                if front.is_empty() {
                    continue;
                }
                let content = |side: &Value| side.get("content").cloned().unwrap_or_else(|| Value::Array(Vec::new()));
                out.push(Card {
                    page_id: page_id.clone(),
                    review: reviews.get(&(page_id.clone(), id.clone())).cloned(),
                    id,
                    front,
                    back: block_text(Some(&back_side), Some(&titles)),
                    front_content: content(&front_side),
                    back_content: content(&back_side),
                });
            }
        }
        Ok(out)
    }

    /// Stores the outcome of studying a card.
    pub fn save_review(&self, page_id: &str, card_id: &str, review: &Review) -> Result<()> {
        check_date(&Some(review.due.clone()))?;
        if !(0..=36_500).contains(&review.interval)
            || !(review.ease.is_finite() && (1.0..=5.0).contains(&review.ease))
            || review.reps < 0
            || review.lapses < 0
            || card_id.is_empty()
            || card_id.len() > 64
        {
            return fail("That review doesn't look right");
        }
        let conn = self.conn();
        let live: Option<i64> = conn
            .query_row("SELECT 1 FROM pages WHERE id = ?1 AND deleted_at IS NULL", [page_id], |r| r.get(0))
            .optional()?;
        if live.is_none() {
            return fail("Page not found");
        }
        conn.execute(
            "INSERT INTO card_reviews (page_id, card_id, due, interval, ease, reps, lapses, reviewed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT (page_id, card_id) DO UPDATE SET
               due = excluded.due, interval = excluded.interval, ease = excluded.ease,
               reps = excluded.reps, lapses = excluded.lapses, reviewed_at = excluded.reviewed_at",
            params![page_id, card_id, review.due, review.interval, review.ease, review.reps, review.lapses, now()],
        )?;
        Ok(())
    }

    /// Forgets one card's progress (undoing its first review makes it new).
    pub fn forget_review(&self, page_id: &str, card_id: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM card_reviews WHERE page_id = ?1 AND card_id = ?2", [page_id, card_id])?;
        Ok(())
    }

    /// Forgets the progress of a page's cards (they're new again).
    pub fn reset_reviews(&self, page_id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM card_reviews WHERE page_id = ?1", [page_id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDb;
    use crate::db::PagePatch;

    fn temp_db() -> TempDb {
        TempDb::new("td-test")
    }

    fn card(id: &str, front: &str, back: &str) -> Value {
        let side = |t: &str, text: &str| {
            if text.is_empty() {
                serde_json::json!({ "type": t })
            } else {
                serde_json::json!({ "type": t, "content": [{ "type": "text", "text": text }] })
            }
        };
        serde_json::json!({
            "type": "flashcard",
            "attrs": { "id": id },
            "content": [side("flashcardFront", front), side("flashcardBack", back)]
        })
    }

    #[test]
    fn cards_are_collected_and_reviews_kept() {
        let db = temp_db();
        let page = db.create_page(None, None, "Bio", "").unwrap();
        let doc = serde_json::json!({ "type": "doc", "content": [
            card("c1", "Mitochondria", "Powerhouse of the cell"),
            { "type": "callout", "content": [card("c2", "Osmosis", "Water across a membrane")] },
            card("c3", "", "no front: skipped"),
        ]});
        db.update_page(&page.id, PagePatch { content: Some(doc.to_string()), ..Default::default() }).unwrap();

        let cards = db.list_cards().unwrap();
        assert_eq!(cards.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["c1", "c2"]);
        assert_eq!(cards[1].back, "Water across a membrane");
        assert!(cards[0].review.is_none());

        let review = Review { due: "2026-10-15".into(), interval: 3, ease: 2.5, reps: 2, lapses: 0 };
        db.save_review(&page.id, "c1", &review).unwrap();
        db.save_review(&page.id, "c1", &Review { reps: 3, ..review.clone() }).unwrap();
        let cards = db.list_cards().unwrap();
        assert_eq!(cards[0].review.as_ref().map(|r| r.reps), Some(3), "upserted");

        // Decks count what's due on a given day without reading every card out.
        let deck = |today: &str| db.list_decks(today).unwrap().pop().unwrap();
        assert_eq!(deck("2026-10-14"), Deck { page_id: page.id.clone(), count: 2, due: 0, fresh: 1, mastered: 0 });
        assert_eq!(deck("2026-10-15").due, 1);
        assert!(db.list_decks("soon").is_err());

        assert!(db.save_review(&page.id, "c1", &Review { ease: 9.0, ..review.clone() }).is_err());
        assert!(db.save_review(&page.id, "c1", &Review { due: "soon".into(), ..review.clone() }).is_err());
        assert!(db.save_review("nope", "c1", &review).is_err());

        db.forget_review(&page.id, "c1").unwrap();
        assert!(db.list_cards().unwrap()[0].review.is_none(), "one card forgotten");
        assert_eq!(db.list_cards().unwrap()[1].front_content[0]["text"], "Osmosis", "content keeps its nodes");

        db.reset_reviews(&page.id).unwrap();
        assert!(db.list_cards().unwrap()[0].review.is_none());
    }
}
