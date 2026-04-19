const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const db = new sqlite3.Database(path.join(__dirname, "budget.db"), (err) => {
  if (err) {
    console.error("Database error:", err.message);
  } else {
    console.log("Database connected / created");
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT UNIQUE NOT NULL,
      monthly_limit REAL NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount REAL NOT NULL,
      category TEXT NOT NULL,
      note TEXT DEFAULT '',
      essential INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const defaultBudgets = [
    ["Food", 3000],
    ["Shopping", 2000],
    ["Travel", 1500],
    ["Entertainment", 1200],
    ["Health", 1000]
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO budgets (category, monthly_limit)
    VALUES (?, ?)
  `);

  defaultBudgets.forEach(([category, limit]) => stmt.run(category, limit));
  stmt.finalize();
});

function getMonthStartEnd() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 10);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    .toISOString()
    .slice(0, 10);
  return { start, end };
}

function daysElapsedInMonth() {
  return new Date().getDate();
}

function daysInMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/test", (req, res) => {
  res.send("Server is working");
});

app.get("/api/budgets", (req, res) => {
  db.all(`SELECT category, monthly_limit FROM budgets ORDER BY category`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get("/api/transactions", (req, res) => {
  db.all(
    `
    SELECT id, amount, category, note, essential, created_at
    FROM transactions
    ORDER BY datetime(created_at) DESC
    LIMIT 20
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.post("/api/transactions", (req, res) => {
  const { amount, category, note = "", essential = 1 } = req.body;

  if (!amount || !category) {
    return res.status(400).json({ error: "amount and category required" });
  }

  db.run(
    `
    INSERT INTO transactions (amount, category, note, essential)
    VALUES (?, ?, ?, ?)
    `,
    [Number(amount), category, note, essential ? 1 : 0],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.get("/api/dashboard", (req, res) => {
  const { start, end } = getMonthStartEnd();

  db.all(
    `
    SELECT category, SUM(amount) AS spent
    FROM transactions
    WHERE date(created_at) BETWEEN ? AND ?
    GROUP BY category
    `,
    [start, end],
    (err, categoryRows) => {
      if (err) return res.status(500).json({ error: err.message });

      db.all(`SELECT category, monthly_limit FROM budgets`, [], (err2, budgets) => {
        if (err2) return res.status(500).json({ error: err2.message });

        db.get(
          `
          SELECT COALESCE(SUM(amount), 0) AS total
          FROM transactions
          WHERE date(created_at) BETWEEN ? AND ?
          `,
          [start, end],
          (err3, totalRow) => {
            if (err3) return res.status(500).json({ error: err3.message });

            db.get(
              `
              SELECT COALESCE(SUM(amount), 0) AS todaySpent
              FROM transactions
              WHERE date(created_at) = date('now')
              `,
              [],
              (err4, todayRow) => {
                if (err4) return res.status(500).json({ error: err4.message });

                const totalSpent = Number(totalRow.total || 0);
                const totalBudget = budgets.reduce((sum, b) => sum + Number(b.monthly_limit), 0);
                const remainingBudget = totalBudget - totalSpent;
                const avgDailySpend = totalSpent / Math.max(1, daysElapsedInMonth());
                const projectedMonthEndSpend = avgDailySpend * daysInMonth();
                const projectedWeeklySpend = avgDailySpend * 7;
                const daysToBroke =
                  avgDailySpend > 0 && remainingBudget > 0
                    ? Math.floor(remainingBudget / avgDailySpend)
                    : null;

                const budgetMap = {};
                budgets.forEach((b) => {
                  budgetMap[b.category] = {
                    monthly_limit: Number(b.monthly_limit),
                    spent: 0
                  };
                });

                categoryRows.forEach((row) => {
                  if (!budgetMap[row.category]) {
                    budgetMap[row.category] = { monthly_limit: 0, spent: 0 };
                  }
                  budgetMap[row.category].spent = Number(row.spent || 0);
                });

                const categoryStats = Object.entries(budgetMap).map(([category, value]) => ({
                  category,
                  monthly_limit: value.monthly_limit,
                  spent: value.spent,
                  percent:
                    value.monthly_limit > 0
                      ? Math.round((value.spent / value.monthly_limit) * 100)
                      : 0
                }));

                const highest = [...categoryStats].sort((a, b) => b.percent - a.percent)[0];

                let warning = "Spending abhi manageable hai.";
                if (highest && highest.percent >= 100) {
                  warning = `${highest.category} budget exceed ho chuka hai.`;
                } else if (highest && highest.percent >= 85) {
                  warning = `${highest.category} budget almost khatam hai.`;
                } else if (projectedMonthEndSpend > totalBudget) {
                  warning = "Current speed se month-end tak budget exceed ho jayega.";
                }

                res.json({
                  totalBudget,
                  totalSpent,
                  remainingBudget,
                  todaySpent: Number(todayRow.todaySpent || 0),
                  avgDailySpend: Number(avgDailySpend.toFixed(2)),
                  projectedMonthEndSpend: Number(projectedMonthEndSpend.toFixed(2)),
                  projectedWeeklySpend: Number(projectedWeeklySpend.toFixed(2)),
                  daysToBroke,
                  warning,
                  categoryStats
                });
              }
            );
          }
        );
      });
    }
  );
});

app.post("/api/chat", (req, res) => {
  const text = String(req.body.message || "").toLowerCase();

  db.get(
    `
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    `,
    [],
    (err, totalRow) => {
      if (err) return res.status(500).json({ error: err.message });

      db.all(`SELECT category, monthly_limit FROM budgets`, [], (err2, budgets) => {
        if (err2) return res.status(500).json({ error: err2.message });

        db.all(
          `
          SELECT category, SUM(amount) AS spent
          FROM transactions
          WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
          GROUP BY category
          `,
          [],
          (err3, categoryRows) => {
            if (err3) return res.status(500).json({ error: err3.message });

            const totalBudget = budgets.reduce((sum, b) => sum + Number(b.monthly_limit), 0);
            const totalSpent = Number(totalRow.total || 0);
            const remaining = totalBudget - totalSpent;
            const avgDaily = totalSpent / Math.max(1, daysElapsedInMonth());
            const daysLeft =
              avgDaily > 0 && remaining > 0 ? Math.floor(remaining / avgDaily) : null;

            const budgetMap = {};
            budgets.forEach((b) => {
              budgetMap[b.category.toLowerCase()] = {
                limit: Number(b.monthly_limit),
                spent: 0
              };
            });

            categoryRows.forEach((r) => {
              const key = r.category.toLowerCase();
              if (!budgetMap[key]) budgetMap[key] = { limit: 0, spent: 0 };
              budgetMap[key].spent = Number(r.spent || 0);
            });

            const keywords = {
              food: ["food", "zomato", "swiggy", "coffee", "pizza", "burger"],
              shopping: ["shopping", "shoes", "dress", "clothes", "amazon", "flipkart", "buy"],
              travel: ["trip", "travel", "uber", "ola", "cab"],
              entertainment: ["movie", "netflix", "party", "game"],
              health: ["health", "doctor", "medicine", "pharmacy"]
            };

            let detectedCategory = null;
            for (const [category, words] of Object.entries(keywords)) {
              if (words.some((word) => text.includes(word))) {
                detectedCategory = category;
                break;
              }
            }

            function categoryReply(categoryLabel) {
              const cat = budgetMap[categoryLabel];
              if (!cat) {
                return `Seedhi baat: abhi extra spending ideal nahi lag rahi. Tumhare paas approx ₹${remaining.toFixed(0)} budget bacha hai.`;
              }

              const percent = cat.limit > 0 ? Math.round((cat.spent / cat.limit) * 100) : 0;

              if (percent >= 100) {
                return `Frankly, ${categoryLabel} budget already exceed ho chuka hai. Ab is category me aur spend smart move nahi hai.`;
              }

              if (percent >= 85) {
                return `Sach bolun? ${categoryLabel} budget almost khatam hai (${percent}%). Agar urgent nahi hai to abhi mat lo.`;
              }

              if (daysLeft !== null && daysLeft <= 10) {
                return `Tempting ho sakta hai, but timing weak hai. Current pace par paisa sirf ${daysLeft} din aur chalega. Non-essential spend avoid karo.`;
              }

              return `Abhi possible hai, but blindly spend mat karo. ${categoryLabel} me tumne ₹${cat.spent.toFixed(0)} spend kiye hain. Pehle decide karo: need hai ya want.`;
            }

            let reply = "";

            if (
              text.includes("can i afford") ||
              text.includes("should i buy") ||
              text.includes("can i buy") ||
              text.includes("should i order")
            ) {
              if (detectedCategory) {
                reply = categoryReply(detectedCategory);
              } else if (daysLeft !== null && daysLeft <= 7) {
                reply = `Honest answer? Abhi unnecessary spending risky hai. Current pace par budget lagbhag ${daysLeft} din aur chalega.`;
              } else {
                reply = `Tumne iss month ₹${totalSpent.toFixed(0)} spend kiye hain aur approx ₹${remaining.toFixed(0)} bacha hai. Agar ye need nahi hai, to abhi mat lo.`;
              }
            } else if (text.includes("shopping")) {
              reply = categoryReply("shopping");
            } else if (text.includes("food") || text.includes("coffee") || text.includes("zomato") || text.includes("swiggy")) {
              reply = categoryReply("food");
            } else if (text.includes("travel") || text.includes("trip") || text.includes("cab")) {
              reply = categoryReply("travel");
            } else if (text.includes("how much") || text.includes("spend")) {
              reply = `Tumne iss month ₹${totalSpent.toFixed(0)} spend kiye hain. Daily average approx ₹${avgDaily.toFixed(0)} hai. Isi speed se chala to month-end tight ho sakta hai.`;
            } else {
              if (daysLeft !== null && daysLeft <= 7) {
                reply = `Main seedha bolunga: abhi paise bachane ka mode on karo. Current speed par budget sirf ${daysLeft} din aur chalega.`;
              } else if (daysLeft !== null && daysLeft <= 15) {
                reply = `Budget critical nahi hai, but safe bhi nahi hai. Non-essential spending thodi slow karo.`;
              } else {
                reply = `Main tumhara money coach hoon. Har spend se pehle ek sawaal poochho: need hai ya bas mood spend?`;
              }
            }

            res.json({ reply });
          }
        );
      });
    }
  );
});

app.use((req, res) => {
  res.status(404).send("Page not found");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});