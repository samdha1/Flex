const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const User = require('../models/User');
const Project = require('../models/Project');
const { protect, authorize } = require('../middleware/authMiddleware');
const { createRateLimiter } = require('../middleware/rateLimit');
const { isValidObjectId, sendError } = require('../utils/validate');

const aiRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  maxRequests: 20,
  keyGenerator: (req) => req.user._id.toString(),
  message: 'AI request limit reached. Try again in an hour.',
});

const getModelName = () => {
  const modelName = process.env.GEMINI_MODEL;
  if (!modelName) throw new Error('GEMINI_MODEL is not defined in environment variables.');
  return modelName;
};

const getGenAI = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not defined in environment variables');
  return new GoogleGenerativeAI(apiKey);
};

const handleGeminiError = (res, error) => {
  console.error('Gemini request failed:', error);
  return res.status(503).json({
    message: 'Gemini is unavailable. Check GEMINI_API_KEY and GEMINI_MODEL, then try again.',
  });
};

const generateJSON = async (prompt) => {
  const genAI = getGenAI();
  const model = genAI.getGenerativeModel({
    model: getModelName(),
    generationConfig: { responseMimeType: 'application/json' },
  });
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const jsonStr = text.replace(/```json\n?|\n?```/g, '').trim();
  return JSON.parse(jsonStr);
};

const isStringList = (value) => (
  Array.isArray(value) && value.every(item => typeof item === 'string')
);

router.post('/analyze-project', protect, aiRateLimiter, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'A valid request body is required.' });
    }
    const { title, description, skills, budgetMin, budgetMax, budgetType } = req.body;
    if (
      typeof title !== 'string' || !title.trim()
      || typeof description !== 'string' || !description.trim()
      || !isStringList(skills)
    ) {
      return res.status(400).json({ message: 'Title and description must be strings, and skills must be an array of strings.' });
    }
    
    const prompt = `Analyze this project listing for a freelancing platform.
    Title: ${title}
    Description: ${description}
    Skills: ${skills.join(', ')}
    Budget: ₹${budgetMin} - ₹${budgetMax} (${budgetType})
    
    Please provide an analysis in JSON format with exactly the following fields:
    {
      "quality": <number 1-100 indicating how clear and attractive the listing is>,
      "complexityLevel": "<short string like 'Low', 'Medium', 'High', 'Expert'>",
      "budgetAssessment": "<short string evaluating the budget e.g., 'Fair', 'Low', 'Generous'>",
      "suggestions": ["<suggestion 1>", "<suggestion 2>"]
    }
    Make sure you return ONLY valid JSON inside \`\`\`json block.`;

    let analysis;
    try {
      analysis = await generateJSON(prompt);
    } catch (error) {
      return handleGeminiError(res, error);
    }
    res.json(analysis);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/match-freelancers', protect, aiRateLimiter, authorize('client'), async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'A valid request body is required.' });
    }
    const { projectId } = req.body;
    if (!isValidObjectId(projectId)) {
      return res.status(400).json({ message: 'Invalid project ID.' });
    }
    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (project.client.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to match freelancers for this project.' });
    }
    
    let freelancers = project.skills?.length
      ? await User.find({ role: 'freelancer', skills: { $in: project.skills } })
        .sort('-rating')
        .limit(10)
      : [];
    if (freelancers.length < 10) {
      const fallbackQuery = { role: 'freelancer' };
      if (freelancers.length > 0) {
        fallbackQuery._id = { $nin: freelancers.map(freelancer => freelancer._id) };
      }
      const fallback = await User.find(fallbackQuery)
        .sort('-rating')
        .limit(10 - freelancers.length);
      freelancers = [...freelancers, ...fallback];
    }
    if (freelancers.length === 0) return res.json({ matches: [] });
    
    const freelancersData = freelancers.map(f => ({
      id: f._id,
      name: f.name,
      skills: f.skills,
      rating: f.rating,
      completedProjects: f.completedProjects
    }));
    
    const prompt = `Act as an AI matchmaker for a freelancing platform.
    Project: ${project.title} - ${project.description}
    Required Skills: ${(project.skills || []).join(', ')}
    
    Available Freelancers Data: ${JSON.stringify(freelancersData)}
    
    Select the top 3 best matching freelancers based on their skills. Return a JSON array of objects, with NO surrounding text, EXACTLY in this format:
    [
      {
        "freelancerId": "<id string>",
        "compatibilityScore": <number 50-99>,
        "reasoning": "<short sentence explaining why>",
        "strengths": ["<strength 1>", "<strength 2>"]
      }
    ]
    Make sure you return ONLY valid JSON inside \`\`\`json block.`;

    let matches;
    try {
      const aiResponse = await generateJSON(prompt);
      if (!Array.isArray(aiResponse)) throw new Error('Gemini returned an invalid freelancer match response.');
      matches = aiResponse.map(match => {
        const freelancer = freelancers.find(f => f._id.toString() === match?.freelancerId);
        if (!freelancer) return null;
        return {
          freelancer: {
            _id: freelancer._id,
            name: freelancer.name,
            rating: freelancer.rating,
            completedProjects: freelancer.completedProjects,
          },
          compatibilityScore: match.compatibilityScore,
          reasoning: match.reasoning,
          strengths: match.strengths,
        };
      }).filter(Boolean);
    } catch (error) {
      return handleGeminiError(res, error);
    }
    
    res.json({ matches });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/improve-proposal', protect, aiRateLimiter, authorize('freelancer'), async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'A valid request body is required.' });
    }
    const { coverLetter, projectTitle, projectDescription, freelancerSkills } = req.body;
    if (
      typeof coverLetter !== 'string' || !coverLetter.trim()
      || typeof projectTitle !== 'string' || !projectTitle.trim()
      || typeof projectDescription !== 'string' || !projectDescription.trim()
      || !isStringList(freelancerSkills)
    ) {
      return res.status(400).json({ message: 'Cover letter, project title, and description must be strings, and freelancer skills must be an array of strings.' });
    }
    
    const prompt = `Review and improve this freelancer proposal cover letter.
    Project: ${projectTitle} - ${projectDescription}
    Freelancer Skills: ${freelancerSkills?.join(', ') || 'None specified'}
    
    Original Cover Letter:
    ${coverLetter}
    
    Provide an improved, professional version and some feedback. Return ONLY valid JSON in this format:
    {
      "score": <number 1-100 rating the original>,
      "improvedVersion": "<the rewritten cover letter>",
      "feedback": ["<tip 1>", "<tip 2>"]
    }
    Make sure you return ONLY valid JSON inside \`\`\`json block.`;

    let improved;
    try {
      improved = await generateJSON(prompt);
    } catch (error) {
      return handleGeminiError(res, error);
    }
    res.json(improved);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/recommend-jobs', protect, aiRateLimiter, authorize('freelancer'), async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    const projects = await Project.find({ status: 'open', visibility: 'public' }).limit(20);
    
    if (projects.length === 0) return res.json({ recommendations: [] });
    
    const projectsData = projects.map(p => ({
      id: p._id,
      title: p.title,
      description: p.description.substring(0, 200),
      skills: p.skills,
      budgetMax: p.budgetMax
    }));
    
    const prompt = `Recommend projects for a freelancer.
    Freelancer Skills: ${(user.skills || []).join(', ')}
    Freelancer Hourly Rate: ₹${user.hourlyRate || 0}
    
    Available Projects: ${JSON.stringify(projectsData)}
    
    Select the top 3 best matching projects. Return ONLY valid JSON inside \`\`\`json block in exactly this format:
    [
      {
        "projectId": "<id string>",
        "matchScore": <number 60-99>,
        "reasoning": "<short explanation why this is a good fit>",
        "whyGoodFit": ["<reason 1>", "<reason 2>"],
        "suggestedBid": <number suggesting an appropriate bid>,
        "coverLetterTip": "<one tip for their cover letter>"
      }
    ]`;

    let recommendations;
    try {
      const aiResponse = await generateJSON(prompt);
      if (!Array.isArray(aiResponse)) throw new Error('Gemini returned an invalid project recommendation response.');
      recommendations = aiResponse.map(match => {
        const project = projects.find(p => p._id.toString() === match?.projectId);
        if (!project) return null;
        return {
          project,
          matchScore: match.matchScore,
          reasoning: match.reasoning,
          whyGoodFit: match.whyGoodFit,
          suggestedBid: match.suggestedBid,
          coverLetterTip: match.coverLetterTip,
        };
      }).filter(Boolean);
    } catch (error) {
      return handleGeminiError(res, error);
    }
    
    res.json({ recommendations });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
