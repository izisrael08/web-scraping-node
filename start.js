const puppeteer = require('puppeteer');
const mssql = require('mssql');
const express = require('express');
const path = require('path');
require ('dotenv').config();
const app = express();

// Configuração do banco de dados
const config = {
    user: process.env.DB_USER, // Usa o valor da variável DB_USER do .env
    password: process.env.DB_PASSWORD, // Usa o valor da variável DB_PASSWORD do .env
    server: process.env.DB_HOST, // Usa o valor da variável DB_HOST do .env
    database: process.env.DB_NAME, // Usa o valor da variável DB_NAME do .env
    options: {
      encrypt: true, // Usado para servidores na nuvem (AWS RDS)
      trustServerCertificate: true // Necessário para certificados autoassinados
    }
  };

// Middleware para servir arquivos estáticos (como index.html) da pasta public
app.use(express.static(path.join(__dirname, 'public')));

// Função para salvar resultados no banco de dados
async function saveResultsToDatabase(results) {
    const pool = await mssql.connect(config);
    const transaction = new mssql.Transaction(pool);

    try {
        await transaction.begin();

        for (const card of results) {
            for (const result of card.results) {
                const checkQuery = `
                    SELECT COUNT(1) AS Count
                    FROM ResultadosLoteria
                    WHERE Titulo = @Titulo AND Hora = @Hora AND Premio = @Premio
                `;
                const request = new mssql.Request(transaction);
                request.input('Titulo', mssql.NVarChar, card.title);
                request.input('Hora', mssql.NVarChar, card.time);
                request.input('Premio', mssql.NVarChar, result.prize);

                const checkResult = await request.query(checkQuery);
                if (checkResult.recordset[0].Count === 0) {
                    const insertQuery = `
                        INSERT INTO ResultadosLoteria (Titulo, Hora, Premio, Resultado, Grupo)
                        VALUES (@Titulo, @Hora, @Premio, @Resultado, @Grupo)
                    `;
                    request.input('Resultado', mssql.NVarChar, result.result);
                    request.input('Grupo', mssql.NVarChar, result.group);
                    await request.query(insertQuery);
                } else {
                    console.log(`Registro duplicado encontrado: ${card.title}, ${card.time}, ${result.prize}`);
                }
            }
        }

        await transaction.commit();
        console.log("Dados inseridos com sucesso!");
    } catch (error) {
        await transaction.rollback();
        console.error("Erro ao salvar os resultados no banco:", error);
    } finally {
        pool.close();
    }
}

// Função para realizar o scraping
async function scrapeWebsite() {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto("https://loteriasbr.com/", { waitUntil: "networkidle2" });

        await page.waitForSelector(".results__card", { timeout: 10000 });

        const results = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll(".results__card"));
            return cards.map(card => {
                const titleElement = card.querySelector(".results__card--title span");
                const timeElement = card.querySelector(".results__card--header > span");
                const tableRows = card.querySelectorAll("tbody tr");

                const title = titleElement ? titleElement.innerText : "Título não encontrado";
                const time = timeElement ? timeElement.innerText : "Hora não encontrada";

                const resultData = Array.from(tableRows).map(row => {
                    const prizeElement = row.querySelector("td");
                    const groupElement = row.querySelector(".results__table-grupo span");
                    const resultElements = row.querySelector(".results__table-align-results");

                    const prize = prizeElement ? prizeElement.innerText : "Prêmio não encontrado";
                    const result = resultElements ? resultElements.innerText.trim().split(" ").join(" ") : "(sem dados)";
                    const group = groupElement ? groupElement.innerText : "Grupo não encontrado";

                    return { prize, result, group };
                }).filter(data => data.prize);

                return { title, time, results: resultData };
            });
        });

        console.log("Dados coletados:", results);

        await saveResultsToDatabase(results);
    } catch (error) {
        console.error("Erro ao fazer scraping:", error);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// Rota para iniciar o scraping
(async () => {
    console.log("Iniciando scraping...");
    await scrapeWebsite();
})();

// Rota para exibir os resultados do banco de dados
app.get('/results', async (req, res) => {
    try {
        const pool = await mssql.connect(config);
        const result = await new mssql.Request(pool).query(`
            SELECT 
                Titulo,
                Hora,
                Premio,
                Resultado,
                Grupo,
                CONVERT(VARCHAR, DataInsercao, 103) AS DataInsercao
            FROM dbo.ResultadosLoteria
            ORDER BY Hora DESC, DataInsercao DESC
        `);

        // Agrupando os resultados de forma correta
        const groupedResults = result.recordset.reduce((acc, current) => {
            const key = current.Titulo + current.Hora;
            if (!acc[key]) {
                acc[key] = {
                    Titulo: current.Titulo,
                    Hora: current.Hora,
                    Dia: current.DataInsercao,
                    Resultados: []
                };
            }
            acc[key].Resultados.push({
                Premio: current.Premio,
                Resultado: current.Resultado,
                Grupo: current.Grupo
            });
            return acc;
        }, {});

        const formattedResults = Object.values(groupedResults).map(card => ({
            Titulo: card.Titulo,
            Hora: card.Hora,
            Dia: card.Dia,
            Resultados: card.Resultados
        }));

        res.json(formattedResults);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao recuperar os resultados', error: error.message });
    }
});

// Iniciar o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
