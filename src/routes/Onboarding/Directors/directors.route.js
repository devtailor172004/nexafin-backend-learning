import express from 'express';
import { verifyToken } from '../../../middlewares/authMiddleware.js';
import documentUpload from '../../../middlewares/documentUpload.js';
import { addDirector, getDirectorList, updateDirector, verifyDirectorPan, uploadDirectorDocument } from '../../../controllers/Onboarding/Directors/directors.controller.js';

const router = express.Router();


router.get('/directors', verifyToken, getDirectorList);
router.post('/directors', verifyToken, getDirectorList);
router.post('/add-director', verifyToken, addDirector);
router.patch('/update-director/:uuid', verifyToken, updateDirector);
router.post('/verify-director-pan', verifyToken, verifyDirectorPan);
router.post('/upload-director-document', verifyToken, documentUpload.single('file'), uploadDirectorDocument);

export default router;