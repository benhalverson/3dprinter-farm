import { Context } from 'hono';
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";

export const questions = async (c: Context) => {
	const question = c.req.query('question');

	const model = new ChatOpenAI({
		configuration: {
			baseURL: c.env.GATEWAY_URL,
		},
		modelName: "gpt-3.5-turbo",
		openAIApiKey: c.env.OPENAI_API_KEY,
	});

	const promptTemplate = PromptTemplate.fromTemplate(
		"Your're a helpful assistant. Question {question}"
	);

	await promptTemplate.pipe(model).invoke({ question: `${question}` });
};
